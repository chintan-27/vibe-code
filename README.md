# Vibe Code

Claude code but tailored for 3B VibeThinker Model, works with ollama api

## Local configuration

Copy `.env.example` to either `<workspace>/.env` for one project or `~/.config/vibe/.env` for credentials shared across every workspace. Vibe also loads the app-root `.env` during local development. `.env` is ignored by git.

For WebSearch, configure one provider:

- Tavily: `VIBE_SEARCH_PROVIDER=tavily` and `TAVILY_API_KEY`
- Brave: `VIBE_SEARCH_PROVIDER=brave` and `BRAVE_API_KEY`
- SearXNG: `VIBE_SEARCH_PROVIDER=searxng` and `SEARXNG_URL`
