## What changes

<!-- Briefly: what and why. If there is a related issue, link it (#number). -->

## How to test

<!-- Steps for the reviewer: what to run, what to look at. -->

## Checklist

- [ ] Ran locally: `ruff check . && ruff format --check .`
- [ ] Ran `mypy`
- [ ] Ran `cd backend && python -m smoke_test`
- [ ] Ran `npm run lint` (if the frontend changed)
- [ ] Updated README / config if behavior or environment variables changed
- [ ] No private data in the diff (answer bank, keys, `.env`, `service-account.json`)
