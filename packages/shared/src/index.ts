export interface ApiError {
  code: "NOT_FOUND" | "INTERNAL_ERROR";
  message: string;
}
export type ApiResult<T> =
  | { ok: true; data: T; request_id: string }
  | { ok: false; error: ApiError; request_id: string };
export interface Health {
  status: "ok";
}
