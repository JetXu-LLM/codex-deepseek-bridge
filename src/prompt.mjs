// The single source for the Path A prompt. `setup --print-prompt` prints exactly
// this and the README "Already using Codex?" block is identical (doc 10 §4).
export const CODEX_SETUP_PROMPT = `Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek.
Treat my DeepSeek API key as a secret: never print it, never write it into a file you show me, never
put it in your replies, never commit it.
Steps:
1. Read https://github.com/JetXu-LLM/codex-deepseek-bridge and follow its setup.
2. If I have Node, install with npm; otherwise download the binary for my OS from the latest release.
3. Run the setup so it asks me to paste my DeepSeek API key in the terminal (stdin), not in this chat.
4. Back up my Codex config, then point Codex at the DeepSeek bridge (models deepseek-pro, deepseek-flash).
5. If I am not signed in to Codex, sign me in with my DeepSeek key. If I am signed in with ChatGPT,
   do not change my login — tell me to log out in Codex, choose "Sign in another way", and enter my
   DeepSeek key.
6. Start the bridge in the background and confirm http://127.0.0.1:8787/report loads.
7. Tell me to restart Codex, and show me the command to start the bridge again next time.
`;
