export { defineOps, type OpsConfig, type OpsInstance } from "./config";
export { prismaUserStore, type PrismaUserStoreOptions } from "./adapters/prismaUserStore";
export {
  type OpsUser, type OpsUserPage, type OpsUserQuery, type OpsUserStore,
  generatePassword, canHardDelete, resetPassword,
} from "./users";
export { writeAudit, listAudit, type AuditInput, type AuditRow } from "./audit";
export {
  runChecks,
  type Check, type CheckContext, type CheckOutcome, type CheckResult, type CheckStatus,
} from "./health/index";
export { checkDb, checkEnv, checkBuild, checkMigrations } from "./health/checks";
export { opsEnabled, isAllowedEmail, verifyCredentials } from "./gate";
