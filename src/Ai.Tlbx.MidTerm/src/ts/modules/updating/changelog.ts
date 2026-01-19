/**
 * Changelog Module
 *
 * Fetches and displays the changelog from GitHub releases.
 */

import { escapeHtml } from '../../utils';

const GITHUB_RELEASES_BASE = 'https://api.github.com/repos/AiTlbx/MidTerm/releases';
const PER_PAGE = 30;
const GITHUB_RELEASES_PAGE = 'https://github.com/AiTlbx/MidTerm/releases';

interface GitHubRelease {
  tag_name?: string;
  published_at?: string;
  body?: string;
}

// Pagination state
let currentPage = 1;
let hasMoreReleases = true;
let isLoading = false;

/**
 * Show the changelog modal and fetch releases from GitHub
 */
export function showChangelog(): void {
  const modal = document.getElementById('changelog-modal');
  const body = document.getElementById('changelog-body');

  // Reset pagination state
  currentPage = 1;
  hasMoreReleases = true;
  isLoading = false;

  if (modal) modal.classList.remove('hidden');
  if (body) body.innerHTML = '<div class="changelog-loading">Loading changelog...</div>';

  fetchReleases(true);
}

/**
 * Fetch releases from GitHub API
 */
function fetchReleases(isInitial: boolean): void {
  if (isLoading) return;
  isLoading = true;

  const body = document.getElementById('changelog-body');
  if (!body) return;

  const url = `${GITHUB_RELEASES_BASE}?per_page=${PER_PAGE}&page=${currentPage}`;

  fetch(url)
    .then((r) => r.json())
    .then((releases: GitHubRelease[]) => {
      isLoading = false;

      if (!releases || !Array.isArray(releases)) {
        if (isInitial) {
          body.innerHTML = '<p>No releases found.</p>';
        }
        hasMoreReleases = false;
        return;
      }

      // Check if there are more pages
      hasMoreReleases = releases.length === PER_PAGE;

      if (releases.length === 0) {
        if (isInitial) {
          body.innerHTML = '<p>No releases found.</p>';
        }
        hasMoreReleases = false;
        return;
      }

      // Build HTML for releases
      let html = '';
      releases.forEach((release) => {
        const version = release.tag_name || 'Unknown';
        const date = release.published_at
          ? new Date(release.published_at).toLocaleDateString()
          : '';
        // Strip version prefix from body since version is already shown in header
        const rawNotes = release.body || 'No release notes.';
        const notes = stripVersionPrefix(rawNotes, version);

        html += '<div class="changelog-release">';
        html += '<div class="changelog-version">' + escapeHtml(version) + '</div>';
        if (date) html += '<div class="changelog-date">' + escapeHtml(date) + '</div>';
        html += '<div class="changelog-notes">' + formatMarkdown(notes) + '</div>';
        html += '</div>';
      });

      if (isInitial) {
        body.innerHTML = html;
      } else {
        // Remove existing load more button before appending
        const existingBtn = body.querySelector('.changelog-load-more');
        if (existingBtn) existingBtn.remove();
        body.insertAdjacentHTML('beforeend', html);
      }

      // Add load more button if there are more releases
      if (hasMoreReleases) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'changelog-load-more';
        loadMoreBtn.textContent = 'Load older releases';
        loadMoreBtn.addEventListener('click', () => {
          currentPage++;
          loadMoreBtn.textContent = 'Loading...';
          loadMoreBtn.disabled = true;
          fetchReleases(false);
        });
        body.appendChild(loadMoreBtn);
      }
    })
    .catch((e) => {
      isLoading = false;
      if (isInitial) {
        body.innerHTML =
          '<p class="changelog-error">Failed to load changelog. ' +
          '<a href="' +
          GITHUB_RELEASES_PAGE +
          '" target="_blank">View on GitHub</a></p>';
      }
      console.error('Changelog error:', e);
    });
}

/**
 * Close the changelog modal
 */
export function closeChangelog(): void {
  const modal = document.getElementById('changelog-modal');
  if (modal) modal.classList.add('hidden');
}

/**
 * Strip version prefix from release notes
 *
 * Removes patterns like "v5.3.0: " or "5.3.0: " from the start of text
 * since the version is already shown in the header.
 */
function stripVersionPrefix(text: string, version: string): string {
  // Remove leading "v" from version if present for matching
  const versionNum = version.replace(/^v/, '');
  // Match "v5.3.0: " or "5.3.0: " at start of text
  const pattern = new RegExp(`^v?${escapeRegex(versionNum)}:\\s*`, 'i');
  return text.replace(pattern, '').trim();
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format markdown links with URL scheme validation.
 * Only allows http/https URLs to prevent XSS via javascript: URLs.
 */
function formatMarkdownLinks(escapedText: string): string {
  return escapedText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return `${text} (${url})`;
  });
}

/**
 * Format markdown text to HTML (basic subset)
 *
 * Supports: headers (## and ###), bold (**text**),
 * links [text](url), and bullet lists (- item)
 */
export function formatMarkdown(text: string): string {
  let html = formatMarkdownLinks(escapeHtml(text))
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Convert list items, then wrap consecutive <li> in <ul>
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, (match) => {
    return '<ul>' + match.replace(/\n/g, '') + '</ul>';
  });

  // Clean up spacing
  html = html.replace(/\n{2,}/g, '\n');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<br>/g, '$1');

  return html;
}
