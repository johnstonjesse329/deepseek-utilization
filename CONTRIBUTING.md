# Contributing

Issues and pull requests are welcome.

```bash
npm install
npm test           # compiles, then runs the unit tests
npm run test:smoke # activates the built extension against a stubbed VS Code host
```

- Keep claims about DeepSeek's pricing or API tied to a link in their first-party docs.
- Put logic in the pure modules (no `vscode` import) and cover it with a unit test.
- Never commit an API key, even a revoked one.

By contributing you agree your work is licensed under the MIT license.
