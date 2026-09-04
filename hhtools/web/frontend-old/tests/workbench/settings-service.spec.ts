import { describe, expect, it } from "vitest";

import type {
  IRequestService,
  JsonRequestOptions,
  UploadPart,
  UploadRequestOptions,
} from "../../src/platform/request/common/request-service";
import { BrowserSettingsService } from "../../src/workbench/services/settings/browser/browser-settings-service";

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

class RecordingRequestService implements IRequestService {
  readonly calls: RecordedCall[] = [];

  get<T>(url: string, _options?: JsonRequestOptions): Promise<T> {
    this.calls.push({ method: "GET", url });
    return Promise.resolve({} as T);
  }

  post<T>(
    url: string,
    body?: unknown,
    _options?: JsonRequestOptions,
  ): Promise<T> {
    this.calls.push({ method: "POST", url, body });
    return Promise.resolve({} as T);
  }

  patch<T>(
    url: string,
    body?: unknown,
    _options?: JsonRequestOptions,
  ): Promise<T> {
    this.calls.push({ method: "PATCH", url, body });
    return Promise.resolve({} as T);
  }

  delete<T>(url: string, _options?: JsonRequestOptions): Promise<T> {
    this.calls.push({ method: "DELETE", url });
    return Promise.resolve({} as T);
  }

  upload<T>(
    url: string,
    _parts: Iterable<UploadPart>,
    _options?: UploadRequestOptions,
  ): Promise<T> {
    this.calls.push({ method: "UPLOAD", url });
    return Promise.resolve({} as T);
  }
}

describe("SettingsService", () => {
  it("keeps route knowledge above the generic request service", async () => {
    const requestService = new RecordingRequestService();
    const settingsService = new BrowserSettingsService(requestService);

    await settingsService.getJobAdmission();
    await settingsService.getMotionLibrary();
    await settingsService.getGvhmrRuntime();

    expect(requestService.calls).toEqual([
      { method: "GET", url: "/api/settings/job-admission" },
      { method: "GET", url: "/api/settings/motion-library" },
      { method: "GET", url: "/api/video-to-motion/status" },
    ]);
  });

  it("uses PATCH only for mutable settings", async () => {
    const requestService = new RecordingRequestService();
    const settingsService = new BrowserSettingsService(requestService);

    await settingsService.saveJobAdmission({
      max_running_jobs: 2,
      max_queued_jobs: 4,
    });
    await settingsService.saveMotionLibrary("/srv/motions");

    expect(requestService.calls).toEqual([
      {
        method: "PATCH",
        url: "/api/settings/job-admission",
        body: { max_running_jobs: 2, max_queued_jobs: 4 },
      },
      {
        method: "PATCH",
        url: "/api/settings/motion-library",
        body: { root: "/srv/motions" },
      },
    ]);
  });
});
