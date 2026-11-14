import dotenv from "dotenv";
import { IntegrationAuditRunner } from "./audit-runner";

dotenv.config({ override: true });

async function main() {
  console.log("=== STARTING MR. HANY LIVE INTEGRATION & FUNCTIONAL AUDIT ===");
  const report = await IntegrationAuditRunner.runAll();
  console.log("=== AUDIT SUMMARY ===", JSON.stringify(report.summary));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal audit error:", err);
  process.exit(1);
});
