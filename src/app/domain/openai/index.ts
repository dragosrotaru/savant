import GPT3Tokenizer from "gpt3-tokenizer";
import { OpenAI } from "openai";

if (!process.env["OPENAI"]) {
  throw new Error("OPENAI environment variable not set");
}

export const openai = new OpenAI({
  apiKey: process.env["OPENAI"],
});

const tokenizer = new GPT3Tokenizer({ type: "gpt3" });

const codeBlockRegex = (language: string) =>
  new RegExp(`\`\`\`${language}([\\s\\S]+?)\`\`\``);

const matchRegex = (regex: RegExp, string: string) => {
  const match = string.match(regex);
  if (match && match.length > 1) {
    // match[0] includes the code block itsel
    return match[1];
  }
  return null;
};

export const extractFirstCodeBlock = (input: string, language: string[]) => {
  for (const lang of language) {
    const code = matchRegex(codeBlockRegex(lang), input);
    if (code) {
      return { code, language: lang };
    }
  }
  return { code: input, language: null };
};

export const requestGPT = (system: string) => async (prompt: string) => {
  const result = await openai.chat.completions.create({
    model: "gpt-4", // "gpt-3.5-turbo-16k-0613",
    messages: [
      {
        role: "system",
        content: system,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  const content = result.choices[0]?.message?.content;
  const useage = result.usage;
  return { content, useage };
};

export const requestCode =
  (language: string[], system: string) => async (prompt: string) => {
    const { content, useage } = await requestGPT(system)(prompt);
    const extract = content ? extractFirstCodeBlock(content, language) : null;
    return {
      code: extract?.code,
      language: extract?.language,
      useage,
    };
  };

export const countTokens = (input: string) =>
  tokenizer.encode(input).bpe.length;
