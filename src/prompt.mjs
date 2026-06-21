// Legacy helper for users who still want Codex to run the setup for them.
// The README now leads with direct commands instead.
export const CODEX_SETUP_PROMPT = `Set up Codex DeepSeek Bridge on this machine so Codex runs on DeepSeek.
Treat my DeepSeek API key as a secret: never print it, never write it into a file you show me, never
put it in your replies, never commit it.
Steps:
1. Read https://github.com/JetXu-LLM/codex-deepseek-bridge and follow its setup.
2. If I have Node, install with npm; otherwise download the binary for my OS from the latest release.
3. Run setup. If no DeepSeek key is already stored on this machine, ask me to paste it in the
   terminal (stdin), not in this chat.
4. Back up my Codex config, then point Codex at the DeepSeek bridge (deepseek-pro by default).
   If Codex Desktop hides custom catalog models, explain the reversible local picker patch and apply
   it only with my explicit approval, or by running setup with --desktop-patch. Only enable
   deepseek-flash when the Desktop picker patch is active.
5. Do not replace my Codex login. Keep my ChatGPT login if I have one, and keep API-key mode if
   that is how I already use Codex. Existing local history should stay visible. The bridge should
   use the local stored DeepSeek key, not Codex's login token.
6. Start the bridge in the background and confirm http://127.0.0.1:8787/report loads.
7. Tell me to restart Codex, and show me the command to start the bridge again next time.
`;
