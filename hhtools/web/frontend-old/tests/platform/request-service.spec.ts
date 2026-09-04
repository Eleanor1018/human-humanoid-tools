import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserRequestService } from "../../src/platform/request/browser/browser-request-service";
import { RequestError } from "../../src/platform/request/common/request-service";

const originalFetch = globalThis.fetch;
const OriginalXMLHttpRequest = globalThis.XMLHttpRequest;

function jsonResponse(
  payload: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest | undefined;

  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;
  readonly headers = new Map<string, string>();

  constructor() {
    FakeXMLHttpRequest.latest = this;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = OriginalXMLHttpRequest;
  FakeXMLHttpRequest.latest = undefined;
  vi.restoreAllMocks();
});

describe("BrowserRequestService", () => {
  it("sends and decodes JSON for every supported method", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ method: "get" }))
      .mockResolvedValueOnce(jsonResponse({ method: "post" }))
      .mockResolvedValueOnce(jsonResponse({ method: "patch" }))
      .mockResolvedValueOnce(jsonResponse({ method: "delete" }));
    globalThis.fetch = fetchMock;
    const service = new BrowserRequestService();
    const controller = new AbortController();

    await expect(service.get<{ method: string }>("/get")).resolves.toEqual({
      method: "get",
    });
    await expect(service.post("/post", { value: 1 })).resolves.toEqual({
      method: "post",
    });
    await expect(
      service.patch("/patch", { value: 2 }, { signal: controller.signal }),
    ).resolves.toEqual({ method: "patch" });
    await expect(service.delete("/delete")).resolves.toEqual({
      method: "delete",
    });

    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "PATCH",
      "DELETE",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe('{"value":1}');
    expect(
      (fetchMock.mock.calls[1]?.[1]?.headers as Headers).get("Content-Type"),
    ).toBe("application/json");
    expect(fetchMock.mock.calls[2]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([
    [{ detail: "plain failure" }, "plain failure"],
    [
      { detail: [{ msg: "first problem" }, { msg: "second problem" }] },
      "first problem; second problem",
    ],
    [{ detail: { msg: "object failure" } }, "object failure"],
    [{ detail: { code: "invalid" } }, '{"code":"invalid"}'],
  ])("normalizes FastAPI error detail %#", async (payload, message) => {
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(payload, { status: 422, statusText: "Unprocessable Entity" }),
    );
    const service = new BrowserRequestService();

    const error = await service.get("/failure").catch((cause) => cause);

    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ message, status: 422 });
  });

  it("uploads multipart files with byte progress", async () => {
    globalThis.XMLHttpRequest =
      FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const service = new BrowserRequestService();
    const progress = vi.fn();
    const file = new File(["motion"], "motion.bvh");

    const result = service.upload<{ job_id: string }>(
      "/api/upload?profile=mimic",
      [{ fieldName: "files", data: file, filename: "set/motion.bvh" }],
      { fields: { label: "training" }, onProgress: progress },
    );
    const xhr = FakeXMLHttpRequest.latest!;
    xhr.upload.onprogress?.({
      loaded: 6,
      total: 12,
      lengthComputable: true,
    } as ProgressEvent);
    xhr.status = 200;
    xhr.responseText = '{"job_id":"job-1"}';
    xhr.onload?.();

    await expect(result).resolves.toEqual({ job_id: "job-1" });
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/upload?profile=mimic");
    expect(progress).toHaveBeenCalledWith({
      loaded: 6,
      total: 12,
      fraction: 0.5,
    });
    const entries = Array.from((xhr.body as FormData).entries());
    expect(entries[0]).toEqual(["label", "training"]);
    expect(entries[1]?.[0]).toBe("files");
    expect((entries[1]?.[1] as File).name).toBe("set/motion.bvh");
  });

  it("uses the same FastAPI error parsing for uploads", async () => {
    globalThis.XMLHttpRequest =
      FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const service = new BrowserRequestService();

    const result = service.upload("/api/upload", []);
    const xhr = FakeXMLHttpRequest.latest!;
    xhr.status = 422;
    xhr.statusText = "Unprocessable Entity";
    xhr.responseText = '{"detail":[{"msg":"bad file"}]}';
    xhr.onload?.();

    await expect(result).rejects.toMatchObject({
      message: "bad file",
      status: 422,
    });
  });

  it("rejects a successful upload whose response is not valid JSON", async () => {
    globalThis.XMLHttpRequest =
      FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const service = new BrowserRequestService();

    const result = service.upload("/api/upload", []);
    const xhr = FakeXMLHttpRequest.latest!;
    xhr.status = 200;
    xhr.responseText = "not-json";
    xhr.onload?.();

    await expect(result).rejects.toBeInstanceOf(SyntaxError);
  });

  it("aborts an active XHR upload through AbortSignal", async () => {
    globalThis.XMLHttpRequest =
      FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const service = new BrowserRequestService();
    const controller = new AbortController();

    const result = service.upload("/api/upload", [], {
      signal: controller.signal,
    });
    const xhr = FakeXMLHttpRequest.latest!;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(xhr.aborted).toBe(true);
  });
});
