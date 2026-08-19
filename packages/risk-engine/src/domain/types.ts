import type { z } from "zod";
import {
  executorAuthorizationSchema,
  policyCheckSchema,
} from "./schemas.js";

export type ExecutorAuthorization = z.infer<typeof executorAuthorizationSchema>;
export type PolicyCheck = z.infer<typeof policyCheckSchema>;
