import type {
  IRequestService,
  JsonRequestOptions,
  UploadPart,
  UploadRequestOptions,
} from "../common/request-service";
import { RequestError } from "../common/request-service";

type JsonMethod = "GET" | "POST" | "PATCH" | "DELETE";

function detailMessage(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          return String(item.msg);
        }
        return typeof item === "string" ? item : JSON.stringify(item);
      })
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    return "msg" in detail
      ? String(detail.msg)
      : JSON.stringify(detail);
  }
  return undefined;
}

function parsePayload(text: string): unknown {
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function requestError(
  status: number,
  statusText: string,
  responseText: string,
): RequestError {
  let detail: unknown;
  try {
    const payload = parsePayload(responseText);
    detail =
      payload && typeof payload === "object" && "detail" in payload
        ? payload.detail
        : undefined;
  } catch {
    detail = undefined;
  }
  const fallback = [status || undefined, statusText || undefined]
    .filter((value) => value !== undefined)
    .join(" ");
  return new RequestError(
    detailMessage(detail) || fallback || "Request failed",
    status,
    detail,
  );
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class BrowserRequestService implements IRequestService {
  get<T>(url: string, options?: JsonRequestOptions): Promise<T> {
    return this.requestJson<T>(url, "GET", undefined, options);
  }

  post<T>(
    url: string,
    body?: unknown,
    options?: JsonRequestOptions,
  ): Promise<T> {
    return this.requestJson<T>(url, "POST", body, options);
  }

  patch<T>(
    url: string,
    body?: unknown,
    options?: JsonRequestOptions,
  ): Promise<T> {
    return this.requestJson<T>(url, "PATCH", body, options);
  }

  delete<T>(url: string, options?: JsonRequestOptions): Promise<T> {
    return this.requestJson<T>(url, "DELETE", undefined, options);
  }

  async requestJson<T>(
    url: string,
    method: JsonMethod,
    body?: unknown,
    options: JsonRequestOptions = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(url, {
      method,
      headers,
      signal: options.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw requestError(
        response.status,
        response.statusText,
        responseText,
      );
    }
    return parsePayload(responseText) as T;
  }

  upload<T>(
    url: string,
    parts: Iterable<UploadPart>,
    options: UploadRequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(abortError());

    const formData = new FormData();
    for (const [name, value] of Object.entries(options.fields ?? {})) {
      formData.append(name, value);
    }
    for (const part of parts) {
      if (part.filename === undefined) {
        formData.append(part.fieldName, part.data);
      } else {
        formData.append(part.fieldName, part.data, part.filename);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onSignalAbort);
        action();
      };
      const onSignalAbort = () => {
        // XHR is retained because fetch upload progress is not portable. Abort
        // must reject even in implementations that omit the `abort` event.
        xhr.abort();
        finish(() => reject(abortError()));
      };

      xhr.upload.onprogress = (event) => {
        options.onProgress?.({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : 0,
          fraction:
            event.lengthComputable && event.total > 0
              ? event.loaded / event.total
              : null,
        });
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const payload = parsePayload(xhr.responseText) as T;
            finish(() => resolve(payload));
          } catch (error) {
            // Parsing happens before `finish` marks the request settled. If a
            // proxy returns malformed JSON with a 2xx status, callers receive
            // the syntax error instead of waiting forever on a pending promise.
            finish(() => reject(error));
          }
          return;
        }
        // Keep FastAPI error messages identical between fetch and XHR paths.
        finish(() =>
          reject(requestError(xhr.status, xhr.statusText, xhr.responseText)),
        );
      };
      xhr.onerror = () =>
        finish(() => reject(new Error("Network request failed")));
      xhr.onabort = () => finish(() => reject(abortError()));

      xhr.open("POST", url, true);
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        xhr.setRequestHeader(name, value);
      }
      options.signal?.addEventListener("abort", onSignalAbort, { once: true });
      xhr.send(formData);
    });
  }
}
