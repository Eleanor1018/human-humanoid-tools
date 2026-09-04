import { Emitter } from "@/base/common/event";
import type {
  LibraryEntry,
  MotionPayload,
} from "@/domain/motion/common/motion";
import type { IRequestService } from "@/platform/request/common/request-service";
import type { IJobService } from "@/workbench/services/jobs/common/job-service";
import type {
  IMotionResultPresentationService,
  IHumanMotionPresentationReservation,
} from "@/workbench/services/motion/common/motion-result-presentation-service";
import type {
  HumanToRobotSelectionResult,
  HumanToRobotState,
  IHumanToRobotService,
} from "../common/human-to-robot-service";

interface JobStartResponse {
  readonly job_id: string;
}

const INITIAL_STATE: HumanToRobotState = Object.freeze({
  motion: null,
  motionPhase: "idle",
  motionProgress: null,
  statusMessage: null,
  error: null,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Browser/Electron implementation of the H2R application service. */
export class BrowserHumanToRobotService implements IHumanToRobotService {
  readonly #requestService: IRequestService;
  readonly #jobService: IJobService;
  readonly #presentationService: IMotionResultPresentationService;
  readonly #stateEmitter = new Emitter<HumanToRobotState>();

  #state = INITIAL_STATE;
  #activeSelection: AbortController | null = null;
  #disposed = false;

  readonly onDidChangeState = this.#stateEmitter.event;

  constructor(
    requestService: IRequestService,
    jobService: IJobService,
    presentationService: IMotionResultPresentationService,
  ) {
    this.#requestService = requestService;
    this.#jobService = jobService;
    this.#presentationService = presentationService;
  }

  get state(): HumanToRobotState {
    return this.#state;
  }

  async selectMotion(
    entry: LibraryEntry,
  ): Promise<HumanToRobotSelectionResult> {
    if (this.#disposed) throw new Error("H2R service is disposed");

    this.#activeSelection?.abort();
    const selection = new AbortController();
    this.#activeSelection = selection;
    this.#setState({
      ...this.#state,
      motionPhase: "loading",
      motionProgress: 0,
      statusMessage: null,
      error: null,
    });

    let presentation: IHumanMotionPresentationReservation | null = null;
    try {
      presentation = await this.#presentationService
        .reserveHumanMotionPresentation(
          { label: entry.stem || entry.sequence_id || entry.name || "motion" },
          { signal: selection.signal },
        );
      const started = await this.#requestService.post<JobStartResponse>(
        "/api/motion/load_library",
        { ...entry, usage: "human_to_robot" },
        { signal: selection.signal },
      );
      const motion = await this.#jobService.waitForResult<MotionPayload>(
        started.job_id,
        {
          signal: selection.signal,
          expectedKind: "motion_load",
          onProgress: (job) => {
            if (this.#activeSelection !== selection) return;
            this.#setState({
              ...this.#state,
              motionProgress: job.progress,
              statusMessage: job.message || null,
            });
          },
        },
      );
      if (this.#activeSelection !== selection) return "superseded";

      const presented = await presentation.commit(motion);
      if (
        presented === "superseded"
        || this.#activeSelection !== selection
      ) return "superseded";

      this.#setState(Object.freeze({
        motion,
        motionPhase: "ready",
        motionProgress: 1,
        statusMessage: null,
        error: null,
      }));
      return "selected";
    } catch (error) {
      if (
        isAbortError(error)
        || selection.signal.aborted
        || this.#activeSelection !== selection
      ) return "superseded";
      this.#setState({
        ...this.#state,
        motionPhase: "error",
        motionProgress: null,
        statusMessage: null,
        error: errorMessage(error),
      });
      throw error;
    } finally {
      presentation?.dispose();
      if (this.#activeSelection === selection) this.#activeSelection = null;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeSelection?.abort();
    this.#activeSelection = null;
    this.#stateEmitter.dispose();
  }

  #setState(state: HumanToRobotState): void {
    this.#state = Object.freeze(state);
    this.#stateEmitter.fire(this.#state);
  }
}
