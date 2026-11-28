// Shared by the gateway, the runner and the llm-proxy (the only code the services share). Each imports it as ../../common/secret.js: the same
// relative path works in the repository (gateway/src -> common) and in the images, where the build copies common/ to /common (see the
// Dockerfiles and `additional_contexts` in infra/docker-compose.gateway.yml).

/**
 * A shared secret must be long and must not be a pattern: a value such as "aaaaaaaaaaaaaaaa" used to be accepted. At least 24 characters
 * and 10 different ones (`openssl rand -hex 24` makes 48 characters from 16 symbols; scripts/gen-secrets.sh prints three).
 * Returns the problem as text, or null when the value will do (docs/security-review.md, SEC-10).
 */
export function secretProblem(value) {
  if (typeof value !== 'string' || value.length < 24) return 'must be at least 24 characters';
  if (new Set(value).size < 10) return 'must not be a repeated or simple pattern (at least 10 different characters): generate it, for example with `openssl rand -hex 24`';
  return null;
}
