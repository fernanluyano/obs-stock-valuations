.PHONY: install dev build typecheck test test-watch clean release help

install:
	npm install

dev:
	npm run dev

build:
	npm run build

typecheck:
	npx tsc -noEmit -skipLibCheck

test:
	npx vitest run

test-watch:
	npx vitest

clean:
	rm -f main.js main.js.map

release:
	scripts/release.sh

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "  install     Install npm dependencies"
	@echo "  dev         Build main.ts and watch for changes (unminified, sourcemaps)"
	@echo "  build       Typecheck then produce a minified production main.js"
	@echo "  typecheck   Run tsc -noEmit over the project"
	@echo "  test        Run the vitest test suite once"
	@echo "  test-watch  Run vitest in watch mode"
	@echo "  clean       Remove build output (main.js, main.js.map)"
	@echo "  release     Prompt for a version bump, then build, test, commit, tag, and publish"
	@echo "  help        Show this message"
