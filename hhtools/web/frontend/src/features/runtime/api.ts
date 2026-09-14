import { createSHA256 } from "hash-wasm";

export interface RuntimeIdentity {
  runtime_id: string;
  workspace_id: string;
  generation: string;
  version: string;
  mode: "local" | "remote";
}

export interface RuntimeOperation {
  name: string;
  description: string;
  scope: string;
  method: string;
  path: string;
  body_parameter: string | null;
  path_parameters: string[];
  query_parameters: string[];
  input_schema: Record<string, unknown>;
}

export interface RuntimeAsset {
  asset_id: string;
  kind: string;
  display_name: string;
  primary_file: string;
  metadata?: { robot_name?: string };
  files: { relative_path: string; size_bytes: number; sha256: string }[];
}

export interface RuntimeArtifact {
  artifact_id: string;
  job_id: string;
  kind: string;
  format?: string;
  size_bytes: number;
  sha256: string;
}

export interface RuntimeJob {
  job_id: string;
  state: string;
  outcome?: string;
  progress: { fraction: number; phase: string; revision: number };
  summary: Record<string, string | number>;
  artifacts: RuntimeArtifact[];
  artifact_count?: number;
  cancellable: boolean;
  error?: { code: string; message: string };
  submitted_at: string;
  attempt: number;
}

export interface RuntimeRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class RuntimeConnection {
  identity: RuntimeIdentity | null = null;
  readonly endpoint: string;
  private readonly token: string;
  constructor(endpoint: string, token = "") {
    this.endpoint = endpoint;
    this.token = token;
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    ) {
      throw new Error("Invalid Runtime endpoint");
    }
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("Remote connections require HTTPS");
    }
  }

  async response(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (this.identity) {
      headers.set("X-HHTools-Runtime", this.identity.runtime_id);
      headers.set("X-HHTools-Workspace", this.identity.workspace_id);
    }
    const response = await fetch(this.endpoint.replace(/\/$/, "") + path, {
      ...init,
      headers,
      redirect: "error",
    });
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ message: `HTTP ${response.status}` }));
      throw new Error(
        [error.code, error.message ?? error.detail].filter(Boolean).join(": "),
      );
    }
    return response;
  }

  async json<T>(
    path: string,
    method = "GET",
    document?: unknown,
    options: RuntimeRequestOptions = {},
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(
            new DOMException("Runtime request timed out", "TimeoutError"),
          ),
          options.timeoutMs,
        );
    try {
      controller.signal.throwIfAborted();
      return await (
        await this.response(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: document === undefined ? undefined : JSON.stringify(document),
          signal: controller.signal,
        })
      ).json() as T;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async connect(
    expected?: { runtime_id?: string; workspace_id?: string },
    options: RuntimeRequestOptions = {},
  ): Promise<RuntimeIdentity> {
    const identity = await this.json<RuntimeIdentity>(
      "/api/runtime/v1/identity",
      "GET",
      undefined,
      options,
    );
    if (
      (expected?.runtime_id && identity.runtime_id !== expected.runtime_id) ||
      (expected?.workspace_id &&
        identity.workspace_id !== expected.workspace_id)
    )
      throw new Error("Runtime identity mismatch");
    this.identity = identity;
    return identity;
  }

  async call(
    operation: RuntimeOperation,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    let path = operation.path;
    const remaining = { ...arguments_ };
    for (const name of operation.path_parameters) {
      if (remaining[name] === undefined) throw new Error(`Missing ${name}`);
      path = path.replace(
        `{${name}}`,
        encodeURIComponent(String(remaining[name])),
      );
      delete remaining[name];
    }
    const query = new URLSearchParams();
    for (const name of operation.query_parameters) {
      if (remaining[name] != null) query.set(name, String(remaining[name]));
      delete remaining[name];
    }
    const body = operation.body_parameter
      ? remaining[operation.body_parameter]
      : undefined;
    if (operation.body_parameter) delete remaining[operation.body_parameter];
    if (Object.keys(remaining).length)
      throw new Error("Unknown operation parameters");
    if (query.size) path += `?${query}`;
    return this.json(path, operation.method, body);
  }

  async upload(
    files: File[],
    kind: string,
    progress: (fraction: number) => void,
  ): Promise<RuntimeAsset> {
    const members = [];
    const total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      const name = file.webkitRelativePath || file.name;
      const sha256 = await digestBlob(file);
      members.push({
        relative_path: name,
        size_bytes: file.size,
        sha256,
        role: "other",
      });
    }
    const entry =
      files.length === 1 && kind !== "dataset_bundle" && kind !== "robot_bundle"
        ? members[0]?.relative_path
        : null;
    const session = await this.json<{ upload_id: string; chunk_bytes: number }>(
      "/api/runtime/v1/uploads",
      "POST",
      {
        kind,
        files: members,
        entry_point: entry,
        display_name:
          files[0]?.webkitRelativePath.split("/")[0] || files[0]?.name,
      },
    );
    let transferred = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const member = members[index]!;
      for (
        let offset = 0;
        offset < Math.max(1, file.size);
        offset += session.chunk_bytes
      ) {
        const query = new URLSearchParams({
          member: member.relative_path,
          offset: String(offset),
        });
        const chunk = file.slice(offset, offset + session.chunk_bytes);
        await this.response(
          `/api/runtime/v1/uploads/${session.upload_id}/content?${query}`,
          {
            method: "PUT",
            body: chunk,
            headers: { "Content-Type": "application/octet-stream" },
          },
        );
        transferred += chunk.size;
        progress(transferred / Math.max(total, 1));
      }
    }
    return this.json<RuntimeAsset>(
      `/api/runtime/v1/uploads/${session.upload_id}/complete`,
      "POST",
    );
  }

  async download(artifact: RuntimeArtifact): Promise<void> {
    const picker = (
      window as Window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
        }) => Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    if (picker) {
      const file = await picker.call(window, {
        suggestedName: `${artifact.kind}.${artifact.format ?? "bin"}`,
      });
      const output = await file.createWritable();
      try {
        const response = await this.response(
          `/api/runtime/v1/jobs/${encodeURIComponent(artifact.job_id)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/content`,
        );
        if (!response.body) throw new Error("Artifact stream is unavailable");
        const reader = response.body.getReader();
        const hash = await createSHA256();
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > artifact.size_bytes)
            throw new Error("Artifact exceeds its declared size");
          hash.update(value);
          await output.write(value);
        }
        if (
          size !== artifact.size_bytes ||
          hash.digest("hex") !== artifact.sha256
        )
          throw new Error("Artifact integrity check failed");
        await output.close();
      } catch (error) {
        await output.abort();
        throw error;
      }
      return;
    }
    if (artifact.size_bytes > 256 * 1024 * 1024)
      throw new Error("This browser cannot stream the selected artifact");
    const blob = await (
      await this.response(
        `/api/runtime/v1/jobs/${encodeURIComponent(artifact.job_id)}/artifacts/${encodeURIComponent(artifact.artifact_id)}/content`,
      )
    ).blob();
    if (
      blob.size !== artifact.size_bytes ||
      (await digestBlob(blob)) !== artifact.sha256
    )
      throw new Error("Artifact integrity check failed");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${artifact.kind}.${artifact.format ?? "bin"}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function digestBlob(blob: Blob): Promise<string> {
  const hash = await createSHA256();
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    hash.update(
      new Uint8Array(
        await blob.slice(offset, offset + 1024 * 1024).arrayBuffer(),
      ),
    );
  }
  return hash.digest("hex");
}
