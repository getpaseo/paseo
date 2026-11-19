// Drops an upstream "Vendor: " prefix ("OpenAI: GPT-5.5"). A colon inside parentheses or after a
// comma belongs to the model name ("DeepSeek V4 (ctx: 128k)"), so it is kept.
function stripVendorPrefix(label: string): string {
  const vendorSeparatorIndex = label.indexOf(": ");
  if (vendorSeparatorIndex === -1 || /[(),]/.test(label.slice(0, vendorSeparatorIndex))) {
    return label;
  }
  return label.slice(vendorSeparatorIndex + 2).trim();
}

// The label Pi and OMP show for a model from their catalogs. A model name is either a path
// ("google/gemini_2.5-flash", as OpenRouter reports it) or free text that can contain slashes
// and underscores ("IQ3_S ... 52/56"). Only paths are shortened.
export function modelDisplayLabel(model: { id: string; name?: string }): string {
  const text = model.name?.trim().replace(/\s+/g, " ") || model.id.trim();
  if (/\s/.test(text)) {
    return stripVendorPrefix(text);
  }
  const lastSegment = text.split("/").findLast((segment) => segment.length > 0) ?? text;
  return stripVendorPrefix(lastSegment.replace(/_+/g, " "));
}
