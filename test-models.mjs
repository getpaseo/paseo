import {
  fetchClaudeModelCatalog,
  fetchCodexModelCatalog,
} from "./packages/server/dist/server/agent/model-catalog.js";

console.log("=== Testing Claude Model Catalog ===\n");
try {
  const claudeModels = await fetchClaudeModelCatalog();
  console.log(`Found ${claudeModels.length} Claude models:\n`);
  claudeModels.forEach((model, idx) => {
    console.log(`${idx + 1}. ${model.label} (${model.id})`);
    console.log(`   Description: ${model.description || "N/A"}`);
    console.log(`   Is Default: ${model.isDefault || false}`);
    console.log("");
  });
} catch (error) {
  console.error("Error fetching Claude models:", error.message);
}

console.log("\n=== Testing Codex Model Catalog ===\n");
try {
  const codexModels = await fetchCodexModelCatalog();
  console.log(`Found ${codexModels.length} Codex models:\n`);
  codexModels.forEach((model, idx) => {
    console.log(`${idx + 1}. ${model.label} (${model.id})`);
    console.log(`   Description: ${model.description || "N/A"}`);
    console.log(`   Is Default: ${model.isDefault || false}`);
    if (model.metadata) {
      console.log(`   Model: ${model.metadata.model || "N/A"}`);
      console.log(`   Default Reasoning Effort: ${model.metadata.defaultReasoningEffort || "N/A"}`);
    }
    console.log("");
  });
} catch (error) {
  console.error("Error fetching Codex models:", error.message);
}
