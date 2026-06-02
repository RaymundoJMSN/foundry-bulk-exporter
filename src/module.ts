import { MODULE_ID } from "./constants";
import { registerBulkExport } from "./scripts/bulk-export";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  registerBulkExport();
});
