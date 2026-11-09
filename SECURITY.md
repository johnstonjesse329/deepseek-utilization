# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/johnstonjesse329/deepseek-utilization/security/advisories/new)
rather than a public issue. Expect an initial response within a few days.

## Scope

The extension stores your DeepSeek API key in VS Code Secret Storage and sends it
only to the configured DeepSeek API base URL. Anything that could leak the key,
send it to another host, or let a workspace redirect it is in scope.
