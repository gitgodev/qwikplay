# Beta Readiness Plan

## 1. Loading & Empty States
- [ ] Skeleton shimmer cards while `songs.json` fetches
- [ ] Error screen with retry button if fetch fails
- [ ] Empty search state with clear-filter CTA
- [ ] Empty queue state with "Pick a track" hint

## 2. Player Robustness
- [ ] Volume persistence in localStorage
- [ ] Repeat mode cycle: off → all → one (button in player bar)
- [ ] Expired audio URL detection → "Track unavailable — try original" state
- [ ] Queue corruption recovery (try/catch + reset)
- [ ] Auto-advance fallback if next track fails to load

## 3. Keyboard Shortcuts
- [ ] `Space` — play/pause
- [ ] `←/→` — seek 5s
- [ ] `↑/↓` — volume
- [ ] `N` — next track, `P` — previous
- [ ] `/` — focus search
- [ ] `?` — show shortcut help overlay

## 4. Visual & Animation
- [ ] Scroll active track into view when playback starts
- [ ] Pulsing glow border on active card
- [ ] Mini equalizer bars on playing card art
- [ ] Smooth card entrance stagger on load
- [ ] Hover lift + shadow deepen on track cards
- [ ] Wave canvas: gradient fill + glow on played portion
- [ ] Queue item slide-in on add
- [ ] Play button morph (▶ ↔ ⏸) with scale bounce
- [ ] Progress bar glow at current position
- [ ] Background glow subtly shifts hue while playing
- [ ] Card art subtle scale on hover
- [ ] Now-playing card gets accent-colored shadow

## 5. Mobile & Touch
- [ ] Swipe hint overlay on rail (first visit, dismissible)
- [ ] Larger touch targets on mobile (buttons ≥ 44px)
- [ ] Pull-to-refresh not needed, but pull-down to reveal search
- [ ] Horizontal swipe momentum on rail (native, verify)
- [ ] Bottom sheet style queue on mobile

## 6. Meta & Sharing
- [ ] Open Graph tags (title, description, image)
- [ ] Twitter card meta
- [ ] Dynamic OG image per track (or default)
- [ ] `manifest.json` for PWA install
- [ ] Theme-color meta

## 7. Accessibility
- [ ] Focus-visible outlines on all interactive elements
- [ ] ARIA live region for now-playing announcements
- [ ] Proper heading hierarchy
- [ ] Color contrast check (accent on dark)
- [ ] Reduced motion media query (respect user pref)
- [ ] Screen reader labels on icon-only buttons

## 8. Performance
- [ ] Intersection Observer for lazy rail rendering (if list grows large)
- [ ] Image preload for next 3 tracks in queue
- [ ] Debounce search input
- [ ] Preconnect to audio CDNs

## 9. Queue UX
- [ ] Drag handle visual affordance
- [ ] Queue position numbers update on reorder
- [ ] "Play next" inserts after current (already done, verify)
- [ ] Clear queue confirmation (undo toast instead of confirm)
- [ ] Queue count badge on toggle button

## 10. Admin & Data
- [ ] Admin: bulk select/hide
- [ ] Admin: reorder tracks (drag to set display order)
- [ ] Admin: add track by URL (SoundCloud/BandLab scrape)
- [ ] Export includes admin notes/ordering

## 11. Analytics (lightweight, self-hosted)
- [ ] Play count per track (localStorage counter)
- [ ] "Top played" sort option
- [ ] Session count

## 12. Final Polish
- [ ] 404/deep-link handling for `?t=` param
- [ ] Console error cleanup
- [ ] Cross-browser test (Safari, Firefox, Chrome)
- [ ] Mobile Safari audio unlock flow
- [ ] README update with features + how to curate
