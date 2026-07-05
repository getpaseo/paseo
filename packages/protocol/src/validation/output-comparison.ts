function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function matchesZodKnownOutput(oracleOutput: unknown, generatedOutput: unknown): boolean {
  if (Object.is(oracleOutput, generatedOutput)) {
    return true;
  }

  if (
    typeof oracleOutput !== "object" ||
    oracleOutput === null ||
    typeof generatedOutput !== "object" ||
    generatedOutput === null ||
    Array.isArray(oracleOutput) !== Array.isArray(generatedOutput)
  ) {
    return false;
  }

  if (Array.isArray(oracleOutput) && Array.isArray(generatedOutput)) {
    if (oracleOutput.length !== generatedOutput.length) {
      return false;
    }
    return oracleOutput.every((value, index) =>
      matchesZodKnownOutput(value, generatedOutput[index]),
    );
  }

  if (!isRecord(oracleOutput) || !isRecord(generatedOutput)) {
    return false;
  }

  return Object.keys(oracleOutput).every(
    (key) =>
      Object.hasOwn(generatedOutput, key) &&
      matchesZodKnownOutput(oracleOutput[key], generatedOutput[key]),
  );
}
