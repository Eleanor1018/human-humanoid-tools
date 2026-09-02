import type {
  GvhmrRuntimeStatus,
  JobAdmissionSettings,
  JobAdmissionSnapshot,
  MotionLibrarySettingsSnapshot,
} from "@/runtime/types";

async function responseError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") return new Error(body.detail);
  } catch {
    // Fall through to the transport status when the server did not send JSON.
  }
  return new Error(`${response.status} ${response.statusText}`);
}

async function request<T>(
  url: string,
  method: "GET" | "PATCH" = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

/** Typed settings gateway keeps transport and validation outside React views. */
export const settingsService = {
  getJobAdmission: () =>
    request<JobAdmissionSnapshot>("/api/settings/job-admission"),
  saveJobAdmission: (settings: JobAdmissionSettings) =>
    request<JobAdmissionSnapshot>(
      "/api/settings/job-admission",
      "PATCH",
      settings,
    ),
  getMotionLibrary: () =>
    request<MotionLibrarySettingsSnapshot>("/api/settings/motion-library"),
  saveMotionLibrary: (root: string) =>
    request<MotionLibrarySettingsSnapshot>(
      "/api/settings/motion-library",
      "PATCH",
      { root },
    ),
  getGvhmrRuntime: () =>
    request<GvhmrRuntimeStatus>("/api/video-to-motion/status"),
};
