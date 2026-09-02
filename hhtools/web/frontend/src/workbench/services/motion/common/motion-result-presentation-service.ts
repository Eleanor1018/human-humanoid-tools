import type { MotionPayload } from "@/domain/motion/common/motion";

/**
 * Commits a generated human motion to the shared application presentation.
 *
 * Callers deliberately see one use-case operation rather than Stage, library,
 * or basket primitives. The temporary browser adapter may use the compatibility
 * runtime internally without leaking that dependency back into a feature.
 */
export interface IMotionResultPresentationService {
  presentHumanMotion(payload: MotionPayload): Promise<void>;
}
