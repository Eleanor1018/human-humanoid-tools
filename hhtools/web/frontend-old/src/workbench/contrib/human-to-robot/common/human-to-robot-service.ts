import type { IDisposable } from "@/base/common/disposable";
import type { Event } from "@/base/common/event";
import type {
  LibraryEntry,
  MotionPayload,
} from "@/domain/motion/common/motion";

export type HumanToRobotMotionPhase =
  | "idle"
  | "loading"
  | "ready"
  | "error";

/** React-facing state for the H2R workflow. */
export interface HumanToRobotState {
  readonly motion: MotionPayload | null;
  readonly motionPhase: HumanToRobotMotionPhase;
  readonly motionProgress: number | null;
  readonly statusMessage: string | null;
  readonly error: string | null;
}

export type HumanToRobotSelectionResult = "selected" | "superseded";

/**
 * Application boundary for Human-to-Robot operations.
 *
 * Views render this state and submit user intent. HTTP, jobs and Stage
 * presentation stay behind the implementation so WebUI and desktop GUI use
 * the same workflow code.
 */
export interface IHumanToRobotService extends IDisposable {
  readonly state: HumanToRobotState;
  readonly onDidChangeState: Event<HumanToRobotState>;

  selectMotion(
    entry: LibraryEntry,
  ): Promise<HumanToRobotSelectionResult>;
}
