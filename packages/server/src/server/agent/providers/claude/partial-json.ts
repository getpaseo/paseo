type PartialParseResult<T> = {
  value: T;
  nextIndex: number;
  complete: boolean;
};

function skipWhitespace(input: string, index: number): number {
  let currentIndex = index;
  while (currentIndex < input.length && /\s/u.test(input[currentIndex] ?? "")) {
    currentIndex += 1;
  }
  return currentIndex;
}

function parsePartialString(
  input: string,
  index: number
): PartialParseResult<string> | null {
  if (input[index] !== "\"") {
    return null;
  }

  let currentIndex = index + 1;
  let value = "";

  while (currentIndex < input.length) {
    const character = input[currentIndex];
    if (character === "\"") {
      return {
        value,
        nextIndex: currentIndex + 1,
        complete: true,
      };
    }

    if (character === "\\") {
      const escapeCharacter = input[currentIndex + 1];
      if (escapeCharacter === undefined) {
        return {
          value,
          nextIndex: input.length,
          complete: false,
        };
      }

      switch (escapeCharacter) {
        case "\"":
        case "\\":
        case "/":
          value += escapeCharacter;
          currentIndex += 2;
          continue;
        case "b":
          value += "\b";
          currentIndex += 2;
          continue;
        case "f":
          value += "\f";
          currentIndex += 2;
          continue;
        case "n":
          value += "\n";
          currentIndex += 2;
          continue;
        case "r":
          value += "\r";
          currentIndex += 2;
          continue;
        case "t":
          value += "\t";
          currentIndex += 2;
          continue;
        case "u": {
          const hex = input.slice(currentIndex + 2, currentIndex + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) {
            return {
              value,
              nextIndex: input.length,
              complete: false,
            };
          }
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          currentIndex += 6;
          continue;
        }
        default:
          return {
            value,
            nextIndex: input.length,
            complete: false,
          };
      }
    }

    value += character;
    currentIndex += 1;
  }

  return {
    value,
    nextIndex: input.length,
    complete: false,
  };
}

function parsePartialLiteral(
  input: string,
  index: number
): PartialParseResult<boolean | null> | null {
  const remaining = input.slice(index);
  if (remaining.startsWith("true")) {
    return { value: true, nextIndex: index + 4, complete: true };
  }
  if (remaining.startsWith("false")) {
    return { value: false, nextIndex: index + 5, complete: true };
  }
  if (remaining.startsWith("null")) {
    return { value: null, nextIndex: index + 4, complete: true };
  }
  return null;
}

function parsePartialNumber(
  input: string,
  index: number
): PartialParseResult<number> | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
    input.slice(index)
  );
  if (!match?.[0]) {
    return null;
  }

  return {
    value: Number(match[0]),
    nextIndex: index + match[0].length,
    complete: true,
  };
}

function parsePartialArray(
  input: string,
  index: number
): PartialParseResult<unknown[]> | null {
  if (input[index] !== "[") {
    return null;
  }

  const values: unknown[] = [];
  let currentIndex = index + 1;

  while (currentIndex <= input.length) {
    currentIndex = skipWhitespace(input, currentIndex);
    const nextCharacter = input[currentIndex];

    if (nextCharacter === "]") {
      return {
        value: values,
        nextIndex: currentIndex + 1,
        complete: true,
      };
    }

    if (nextCharacter === undefined) {
      return {
        value: values,
        nextIndex: input.length,
        complete: false,
      };
    }

    const parsedValue = parsePartialJsonValue(input, currentIndex);
    if (!parsedValue) {
      return {
        value: values,
        nextIndex: currentIndex,
        complete: false,
      };
    }

    values.push(parsedValue.value);
    currentIndex = skipWhitespace(input, parsedValue.nextIndex);

    if (!parsedValue.complete) {
      return {
        value: values,
        nextIndex: currentIndex,
        complete: false,
      };
    }

    const delimiter = input[currentIndex];
    if (delimiter === ",") {
      currentIndex += 1;
      continue;
    }
    if (delimiter === "]") {
      return {
        value: values,
        nextIndex: currentIndex + 1,
        complete: true,
      };
    }
    if (delimiter === undefined) {
      return {
        value: values,
        nextIndex: input.length,
        complete: false,
      };
    }

    return {
      value: values,
      nextIndex: currentIndex,
      complete: false,
    };
  }

  return {
    value: values,
    nextIndex: input.length,
    complete: false,
  };
}

function parsePartialObject(
  input: string,
  index: number
): PartialParseResult<Record<string, unknown>> | null {
  if (input[index] !== "{") {
    return null;
  }

  const value: Record<string, unknown> = {};
  let currentIndex = index + 1;

  while (currentIndex <= input.length) {
    currentIndex = skipWhitespace(input, currentIndex);
    const nextCharacter = input[currentIndex];

    if (nextCharacter === "}") {
      return {
        value,
        nextIndex: currentIndex + 1,
        complete: true,
      };
    }

    if (nextCharacter === undefined) {
      return {
        value,
        nextIndex: input.length,
        complete: false,
      };
    }

    const parsedKey = parsePartialString(input, currentIndex);
    if (!parsedKey?.complete) {
      return {
        value,
        nextIndex: parsedKey?.nextIndex ?? currentIndex,
        complete: false,
      };
    }

    currentIndex = skipWhitespace(input, parsedKey.nextIndex);
    if (input[currentIndex] !== ":") {
      return {
        value,
        nextIndex: currentIndex,
        complete: false,
      };
    }

    currentIndex = skipWhitespace(input, currentIndex + 1);
    const parsedMemberValue = parsePartialJsonValue(input, currentIndex);
    if (!parsedMemberValue) {
      return {
        value,
        nextIndex: currentIndex,
        complete: false,
      };
    }

    value[parsedKey.value] = parsedMemberValue.value;
    currentIndex = skipWhitespace(input, parsedMemberValue.nextIndex);

    if (!parsedMemberValue.complete) {
      return {
        value,
        nextIndex: currentIndex,
        complete: false,
      };
    }

    const delimiter = input[currentIndex];
    if (delimiter === ",") {
      currentIndex += 1;
      continue;
    }
    if (delimiter === "}") {
      return {
        value,
        nextIndex: currentIndex + 1,
        complete: true,
      };
    }
    if (delimiter === undefined) {
      return {
        value,
        nextIndex: input.length,
        complete: false,
      };
    }

    return {
      value,
      nextIndex: currentIndex,
      complete: false,
    };
  }

  return {
    value,
    nextIndex: input.length,
    complete: false,
  };
}

function parsePartialJsonValue(
  input: string,
  index: number
): PartialParseResult<unknown> | null {
  const currentIndex = skipWhitespace(input, index);
  const character = input[currentIndex];

  if (character === undefined) {
    return null;
  }

  if (character === "\"") {
    return parsePartialString(input, currentIndex);
  }
  if (character === "{") {
    return parsePartialObject(input, currentIndex);
  }
  if (character === "[") {
    return parsePartialArray(input, currentIndex);
  }
  if (character === "t" || character === "f" || character === "n") {
    return parsePartialLiteral(input, currentIndex);
  }
  if (character === "-" || /\d/u.test(character)) {
    return parsePartialNumber(input, currentIndex);
  }

  return null;
}

export function parsePartialJsonObject(
  input: string
): { value: Record<string, unknown>; complete: boolean } | null {
  const currentIndex = skipWhitespace(input, 0);
  const parsed = parsePartialObject(input, currentIndex);
  if (!parsed) {
    return null;
  }

  return {
    value: parsed.value,
    complete:
      parsed.complete && skipWhitespace(input, parsed.nextIndex) === input.length,
  };
}
