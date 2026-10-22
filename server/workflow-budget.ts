export const EVALUATION_TIMEOUT_MS = 240000;
export const FINISH_RESERVE_MS = 15000;
export function canStartEvaluation(deadline: number, now = Date.now()) {
  return deadline - now >= EVALUATION_TIMEOUT_MS + FINISH_RESERVE_MS;
}
