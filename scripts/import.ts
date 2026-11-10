import { initializeWorkspace, importRepository } from "../lib/importer";
initializeWorkspace();
console.log(JSON.stringify(importRepository(), null, 2));
