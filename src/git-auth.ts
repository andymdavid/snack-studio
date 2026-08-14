const GITHUB_CREDENTIAL_HELPER = `!f() {
  test "$1" = get || exit 0
  test -n "$WINGMAN_GITHUB_TOKEN" || exit 0
  printf '%s\\n' "username=\${WINGMAN_GITHUB_USERNAME:-x-access-token}" "password=$WINGMAN_GITHUB_TOKEN"
}; f`;

export function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!source.WINGMAN_GITHUB_TOKEN) return source;

  const env = { ...source };
  const count = Number.parseInt(source.GIT_CONFIG_COUNT || '0', 10);
  const next = Number.isFinite(count) && count >= 0 ? count : 0;
  env.GIT_CONFIG_COUNT = String(next + 1);
  env[`GIT_CONFIG_KEY_${next}`] = 'credential.https://github.com.helper';
  env[`GIT_CONFIG_VALUE_${next}`] = GITHUB_CREDENTIAL_HELPER;
  return env;
}
