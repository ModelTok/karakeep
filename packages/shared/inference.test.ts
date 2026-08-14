import OpenAI, { APIConnectionError } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpenAIInferenceClient } from "./inference";
import type { OpenAIInferenceConfig } from "./inference";
import { QueueRetryAfterError } from "./queueing";

const capturedBodies: Record<string, unknown>[] = [];
const tagSchema = z.object({ tags: z.array(z.string()) });

vi.mock("openai", () => {
  class MockAPIConnectionError extends Error {
    constructor({ message }: { message?: string; cause?: Error } = {}) {
      super(message);
      this.name = "APIConnectionError";
    }
  }

  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          capturedBodies.push(body);
          return {
            choices: [{ message: { content: "{}" } }],
            usage: { total_tokens: 1 },
          };
        }),
      },
    },
  }));

  return { default: OpenAIMock, APIConnectionError: MockAPIConnectionError };
});

vi.mock("openai/helpers/zod", () => ({
  zodResponseFormat: (schema: unknown, name: string) => ({
    type: "json_schema",
    json_schema: { name, schema },
  }),
}));

function makeConfig(
  outputSchema: OpenAIInferenceConfig["outputSchema"],
): OpenAIInferenceConfig {
  return {
    apiKey: "test-key",
    textModel: "test-text-model",
    imageModel: "test-image-model",
    contextLength: 2048,
    maxOutputTokens: 1024,
    useMaxCompletionTokens: false,
    outputSchema,
  };
}

describe("OpenAIInferenceClient response_format", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  it("omits response_format for schema-less text inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromText("summarize this text", { schema: null });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toBeUndefined();
  });

  it("keeps json_object for schema-backed text inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromText("infer tags as json", { schema: tagSchema });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format for schema-less image inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromImage("describe this image", "image/png", "BASE64", {
      schema: null,
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toBeUndefined();
  });

  it("keeps structured response_format for schema-backed text inference in structured mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("structured"));

    await client.inferFromText("infer tags", { schema: tagSchema });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "schema" },
    });
  });
});

describe("OpenAIInferenceClient connection failure handling", () => {
  it("converts a connection error into a QueueRetryAfterError instead of failing the job", async () => {
    vi.mocked(OpenAI).mockImplementationOnce(
      () =>
        ({
          chat: {
            completions: {
              create: vi
                .fn()
                .mockRejectedValueOnce(
                  new APIConnectionError({ message: "connect ECONNREFUSED" }),
                ),
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await expect(
      client.inferFromText("summarize this text", { schema: null }),
    ).rejects.toBeInstanceOf(QueueRetryAfterError);
  });

  it("does not convert other API errors (e.g. bad requests) into retry-later", async () => {
    vi.mocked(OpenAI).mockImplementationOnce(
      () =>
        ({
          chat: {
            completions: {
              create: vi
                .fn()
                .mockRejectedValueOnce(new Error("400 invalid request")),
            },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
    );
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await expect(
      client.inferFromText("summarize this text", { schema: null }),
    ).rejects.not.toBeInstanceOf(QueueRetryAfterError);
  });
});
