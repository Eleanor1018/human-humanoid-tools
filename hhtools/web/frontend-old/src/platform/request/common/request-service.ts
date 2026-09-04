export type JsonRequestHeaders = Readonly<Record<string, string>>;

export interface JsonRequestOptions {
  readonly headers?: JsonRequestHeaders;
  readonly signal?: AbortSignal;
}

export interface UploadPart {
  readonly fieldName: string;
  readonly data: Blob;
  readonly filename?: string;
}

export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly fraction: number | null;
}

export interface UploadRequestOptions extends JsonRequestOptions {
  readonly fields?: Readonly<Record<string, string>>;
  readonly onProgress?: (progress: UploadProgress) => void;
}

/** HTTP failure normalized across fetch-based JSON calls and XHR uploads. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * Implementation-neutral transport boundary shared by browser and Electron.
 *
 * The generic result belongs to the caller, so a product API wrapper can map
 * route strings to response types without teaching this layer about HHTools
 * workflows. This contract performs no request itself; implementations normalize
 * transport concerns only: JSON, FastAPI errors, upload progress, and cancellation.
 */
export interface IRequestService {
  get<T>(url: string, options?: JsonRequestOptions): Promise<T>;
  post<T>(
    url: string,
    body?: unknown,
    options?: JsonRequestOptions,
  ): Promise<T>;
  patch<T>(
    url: string,
    body?: unknown,
    options?: JsonRequestOptions,
  ): Promise<T>;
  delete<T>(url: string, options?: JsonRequestOptions): Promise<T>;
  upload<T>(
    url: string,
    parts: Iterable<UploadPart>,
    options?: UploadRequestOptions,
  ): Promise<T>;
}
