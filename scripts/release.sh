#!/usr/bin/env bash
# Bumps the plugin version, builds/tests, commits, pushes, tags, and publishes
# the GitHub release created by .github/workflows/release.yml.
#
# Usage:
#   scripts/release.sh    # prompts for bump type, then confirms the new version
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
	echo "Working tree isn't clean — commit or stash your changes first." >&2
	git status --short
	exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
current_version="$(node -p "require('./manifest.json').version")"
min_app_version="$(node -p "require('./manifest.json').minAppVersion")"

echo "Current version: $current_version"
echo "Bump type: (1) patch  (2) minor  (3) major  (4) custom version"
read -rp "Choose [1-4]: " choice
case "$choice" in
	1) bump="patch" ;;
	2) bump="minor" ;;
	3) bump="major" ;;
	4) read -rp "Enter version (e.g. 0.3.0): " bump ;;
	*) echo "Invalid choice." >&2; exit 1 ;;
esac

new_version="$(node -e "
const current = '$current_version';
const bump = '$bump';
if (/^\d+\.\d+\.\d+$/.test(bump)) { console.log(bump); process.exit(0); }
const [major, minor, patch] = current.split('.').map(Number);
if (bump === 'major') console.log([major + 1, 0, 0].join('.'));
else if (bump === 'minor') console.log([major, minor + 1, 0].join('.'));
else if (bump === 'patch') console.log([major, minor, patch + 1].join('.'));
else { console.error('Unknown bump type: ' + bump); process.exit(1); }
")"

read -rp "Bump $current_version -> $new_version. Continue? [y/N]: " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
	echo "Aborted."
	exit 1
fi

node -e "
const fs = require('fs');

const manifestPath = './manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = '$new_version';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');

const pkgPath = './package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = '$new_version';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n');

const versionsPath = './versions.json';
const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
versions['$new_version'] = '$min_app_version';
fs.writeFileSync(versionsPath, JSON.stringify(versions, null, '\t') + '\n');
"

echo "Running build and tests..."
make build
make test

git add manifest.json package.json versions.json
git commit -m "prepare release build"
git push origin "$branch"

git tag "$new_version"
git push origin "$new_version"

echo "Waiting for the release workflow to start..."
run_id=""
for _ in $(seq 1 30); do
	run_id="$(gh run list --workflow=release.yml --json databaseId,headBranch -q ".[] | select(.headBranch == \"$new_version\") | .databaseId" | head -n1)"
	if [ -n "$run_id" ]; then
		break
	fi
	sleep 5
done

if [ -z "$run_id" ]; then
	echo "Couldn't find the release workflow run for tag $new_version — check GitHub Actions manually." >&2
	exit 1
fi

echo "Watching run $run_id..."
gh run watch "$run_id" --exit-status

echo "Publishing release $new_version..."
gh release edit "$new_version" --draft=false --latest

echo "Done: $(gh release view "$new_version" --json url -q .url)"
