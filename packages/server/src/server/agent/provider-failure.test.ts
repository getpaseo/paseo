import { describe, expect, test } from "vitest";
import {
  describeProviderFailure,
  isModelCapacityError,
  providerRetryDelayMs,
  shouldRetryProviderFailure,
} from "./provider-failure.js";

const OVERLOADED = JSON.stringify({
  name: "APIError",
  data: {
    message: "Our servers are currently overloaded. Please try again later.",
    statusCode: 503,
    isRetryable: true,
    responseHeaders: { "cf-ray": "irrelevant" },
  },
});

describe("describeProviderFailure", () => {
  test("reads the provider's own blob instead of showing it", () => {
    const failure = describeProviderFailure(OVERLOADED);
    expect(failure.message).toBe(
      "Our servers are currently overloaded. Please try again later. (HTTP 503)",
    );
    expect(failure.statusCode).toBe(503);
    expect(failure.retryable).toBe(true);
  });

  test("the provider's verdict outranks its status code", () => {
    const failure = describeProviderFailure(
      JSON.stringify({ data: { message: "Nope", statusCode: 503, isRetryable: false } }),
    );
    expect(failure.retryable).toBe(false);
  });

  test("a status code decides when no verdict came with it", () => {
    expect(describeProviderFailure(JSON.stringify({ data: { statusCode: 429 } })).retryable).toBe(
      true,
    );
    expect(describeProviderFailure(JSON.stringify({ data: { statusCode: 400 } })).retryable).toBe(
      false,
    );
  });

  test("plain text survives untouched and is read for what it says", () => {
    expect(describeProviderFailure("Model is overloaded").retryable).toBe(true);
    expect(describeProviderFailure("Model is overloaded").message).toBe("Model is overloaded");
    expect(describeProviderFailure("Invalid API key").retryable).toBe(false);
  });

  test("a code from the stream joins the sentence", () => {
    expect(describeProviderFailure("Boom", "provider_crash").message).toBe("Boom (provider_crash)");
  });

  test("an empty failure still says something", () => {
    expect(describeProviderFailure("  ").message).toBe("Provider run failed");
  });

  test("malformed JSON is text, not a parse error", () => {
    expect(describeProviderFailure('{"broken":').message).toBe('{"broken":');
  });
});

describe("shouldRetryProviderFailure", () => {
  const failure = describeProviderFailure(OVERLOADED);

  test("retries a passing upstream failure", () => {
    expect(
      shouldRetryProviderFailure({
        failure,
        attempt: 1,
        maxAttempts: 3,
        producedSideEffects: false,
      }),
    ).toBe(true);
  });

  test("stops once the attempts are spent", () => {
    expect(
      shouldRetryProviderFailure({
        failure,
        attempt: 3,
        maxAttempts: 3,
        producedSideEffects: false,
      }),
    ).toBe(false);
  });

  test("never replays a turn that already ran a tool", () => {
    expect(
      shouldRetryProviderFailure({
        failure,
        attempt: 1,
        maxAttempts: 3,
        producedSideEffects: true,
      }),
    ).toBe(false);
  });

  test("a rejected request is not worth repeating", () => {
    expect(
      shouldRetryProviderFailure({
        failure: describeProviderFailure("Invalid API key"),
        attempt: 1,
        maxAttempts: 3,
        producedSideEffects: false,
      }),
    ).toBe(false);
  });
});

describe("providerRetryDelayMs", () => {
  test("backs off and then holds", () => {
    expect(providerRetryDelayMs(1)).toBe(1000);
    expect(providerRetryDelayMs(2)).toBe(2000);
    expect(providerRetryDelayMs(3)).toBe(4000);
    expect(providerRetryDelayMs(10)).toBe(15000);
  });
});

test("quota fallback exhaustion outranks an upstream retryable flag", () => {
  expect(
    describeProviderFailure(
      JSON.stringify({ data: { message: "quota exceeded", statusCode: 429, isRetryable: true } }),
      "quota_fallback_exhausted",
    ).retryable,
  ).toBe(false);
  expect(
    describeProviderFailure(
      JSON.stringify({ data: { message: "overloaded", statusCode: 503, isRetryable: true } }),
    ).retryable,
  ).toBe(true);
});

test("classifies exact model capacity separately from quota and transient 503", () => {
  expect(
    isModelCapacityError({
      message: "Selected model is at capacity. Please try a different model.",
    }),
  ).toBe(true);
  expect(isModelCapacityError({ diagnostic: "Selected model is at capacity" })).toBe(true);
  expect(isModelCapacityError({ message: "quota limit reached (429)" })).toBe(false);
  expect(isModelCapacityError({ message: "Our servers are overloaded (503)" })).toBe(false);
});
