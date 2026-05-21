export interface Config {
  bugsnag: {
    projectId: string;
    pageSize: number;
  };
  mongo: {
    database: string;
  };
  llm: {
    baseUrl: string;
    embeddingModel: string;
    chatModel: string;
  };
  grouping: {
    embeddingSimilarityAutoMergeThreshold: number;
    embeddingSimilarityLLMCandidateThreshold: number;
    templateExtractionMinEvents: number;
    trendTopNGroups: number;
  };
  ui: {
    port: number;
  };
}

const configPath = new URL("../config.json", import.meta.url).pathname;
const raw = JSON.parse(await Deno.readTextFile(configPath));

export const config: Config = raw;

export const env = {
  bugsnagApiKey: Deno.env.get("BUGSNAG_API_KEY") ?? "",
  mongoUri: Deno.env.get("MONGO_URI") ?? "mongodb://localhost:27017",
};
