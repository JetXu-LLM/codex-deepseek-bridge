// The single source for the Path A prompt. `setup --print-prompt` prints exactly
// this and the README "Already using Codex?" block is identical (doc 10 §4).
export const CODEX_SETUP_PROMPT = `Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek.
Treat my DeepSeek API key as a secret: never print it, never write it into a file you show me, never
put it in your replies, never commit it.
Steps:
1. Read https://github.com/JetXu-LLM/codex-deepseek-bridge and follow its setup.
2. If I have Node, install with npm; otherwise download the binary for my OS from the latest release.
3. Run setup. If no DeepSeek key is already stored on this machine, ask me to paste it in the
   terminal (stdin), not in this chat.
4. Back up my Codex config, then point Codex at the DeepSeek bridge (models deepseek-pro, deepseek-flash).
5. Do not replace my Codex login. Keep my ChatGPT login if I have one, so my history stays visible.
   The bridge should use the local stored DeepSeek key, not Codex's login token.
6. Start the bridge in the background and confirm http://127.0.0.1:8787/report loads.
7. Tell me to restart Codex, and show me the command to start the bridge again next time.
`;
