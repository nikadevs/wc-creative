import React, { useEffect, useRef, useState } from 'react';
import { Star, Check, Trash, ArrowSquareOut, Play } from '@phosphor-icons/react';
import { setStarred, isStarred } from '@/lib/ads';
import { useMediaUrl } from '@/lib/media';
import { daysRunning } from '@/features/capture/dates';
import { bulkDelete } from '@/lib/library/bulk';

// Permalink to THIS ad, never to the advertiser page. The importer writes
// metrics.ad_permalink; older rows only have metrics.source_url. If neither is
// there we render no link at all rather than guessing one from the page name,
// because a link that lands on the wrong ad is worse than no link.
export function adPermalink(ad) {
  const m = ad?.metrics || {};
  const url = m.ad_permalink || m.source_url;
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

// Running or ended. metrics.live is what the Ad Library said at capture or
// at the last sync; status is the older field.
export function isRunning(ad) {
  const live = ad?.metrics?.live;
  if (typeof live === 'boolean') return live;
  return ad?.status !== 'dead';
}

// Days live, counted to today while it still runs, so the number does not
// freeze at the day it was saved.
export function daysLive(ad, now = new Date()) {
  const m = ad?.metrics || {};
  const running = isRunning(ad);
  const fromDates = daysRunning(m.started_running || null, running ? null : m.stopped_running || null, now);
  if (fromDates !== null) return fromDates;
  const stored = Number(m.days_running);
  return m.days_running !== null && m.days_running !== '' && Number.isFinite(stored) ? stored : null;
}

function Creative({ ad }) {
  const url = useMediaUrl(ad.media_path);
  const video = useRef(null);
  const [playing, setPlaying] = useState(false);
  const isVideo = ad.format === 'video';

  if (!ad.media_path) {
    return <div className="w-full aspect-square bg-canvas flex items-center justify-center text-small text-ink-soft">No creative saved</div>;
  }
  if (!url) return <div className="w-full aspect-[4/5] bg-canvas animate-pulse" />;

  if (!isVideo) {
    return <img src={url} alt="" loading="lazy" className="w-full h-auto max-h-[75vh] object-contain bg-canvas" />;
  }

  const toggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  return (
    <div className="relative w-full bg-[#000] cursor-pointer" onClick={toggle}>
      {/* #t=0.1 makes the browser show the first frame as the poster. */}
      <video
        ref={video}
        src={`${url}#t=0.1`}
        preload="metadata"
        playsInline
        controls={playing}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="w-full h-auto max-h-[75vh] object-contain block"
      />
      {!playing && (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-14 h-14 rounded-full bg-[#000]/55 text-[#fff] flex items-center justify-center">
            <Play size={26} weight="fill" />
          </span>
        </span>
      )}
    </div>
  );
}

// One creative per card: a single line on top (running or ended, days live,
// Open Ad, star, delete) and the creative under it at full card width. A click
// on a video plays it in place.
// Supports an optional selection mode (for bulk actions and Compare): when
// `selectable` is set the whole card toggles selection instead.
// `onAdChange` hears about a star toggled on the card, `onAdDeleted` about a
// delete, so a list can keep its rows in step.
export default function AdCard({ ad, selectable = false, selected = false, onToggleSelect, focused = false, onAdChange, onAdDeleted }) {
  const [starred, setStar] = useState(isStarred(ad));
  const propStarred = isStarred(ad);
  useEffect(() => setStar(propStarred), [propStarred]);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!confirming) return undefined;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const toggleStar = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !starred;
    setStar(next); // optimistic
    const ok = await setStarred(ad, next);
    if (!ok) {
      setStar(!next);
      return;
    }
    onAdChange?.({ ...ad, metrics: { ...(ad.metrics || {}), starred: next } });
  };

  // Two taps: the first arms the bin, the second deletes. No browser dialog.
  const remove = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setDeleting(true);
    setError('');
    const result = await bulkDelete([ad]);
    setDeleting(false);
    if (!result.ok) {
      setError(result.failed?.[0]?.message || 'Could not delete.');
      return;
    }
    onAdDeleted?.(ad);
  };

  const running = isRunning(ad);
  const days = daysLive(ad);
  const permalink = adPermalink(ad);

  const bar = (
    <div className={`flex items-center gap-2 min-h-[44px] whitespace-nowrap ${selectable ? 'pl-12 pr-1' : 'pl-4 pr-1'} text-meta`}>
      <span
        role="img"
        aria-label={running ? 'Running' : 'Ended'}
        title={running ? 'Running' : 'Ended'}
        className={`flex-shrink-0 w-2.5 h-2.5 rounded-full ${running ? 'bg-status-good' : 'bg-status-bad'}`}
      />
      {days !== null && <span className="num text-meta text-ink-soft">{days}d</span>}
      <span className="flex-1" />
      {permalink && (
        <a
          href={permalink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label="Open Ad"
          title="Open Ad"
          className="w-11 h-11 flex flex-shrink-0 items-center justify-center rounded-full text-ink-soft hover:text-ink hover:bg-card-hi"
        >
          <ArrowSquareOut size={20} weight="bold" />
        </a>
      )}
      <button
        type="button"
        onClick={toggleStar}
        aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={starred}
        className={`w-11 h-11 flex flex-shrink-0 items-center justify-center rounded-full hover:bg-card-hi ${starred ? 'text-status-warn' : 'text-ink-soft hover:text-ink'}`}
      >
        <Star size={20} weight={starred ? 'fill' : 'bold'} />
      </button>
      <button
        type="button"
        onClick={remove}
        disabled={deleting}
        aria-label={confirming ? 'Tap again to delete' : 'Delete ad'}
        title={confirming ? 'Tap again to delete' : 'Delete ad'}
        className={`h-11 flex flex-shrink-0 items-center justify-center rounded-full ${
          confirming ? 'px-3 bg-status-bad text-[#fff] font-semibold' : 'w-11 text-ink-soft hover:text-status-bad hover:bg-card-hi'
        } ${deleting ? 'opacity-50' : ''}`}
      >
        {confirming ? 'Delete?' : <Trash size={20} weight="bold" />}
      </button>
    </div>
  );

  const selectMark = selectable && (
    <span
      aria-hidden="true"
      className={`absolute top-3 left-3 z-10 w-6 h-6 rounded-full flex items-center justify-center border-2 ${
        selected ? 'bg-accent border-accent text-black' : 'border-ink-soft/50 text-transparent'
      }`}
    >
      <Check size={14} weight="bold" />
    </span>
  );

  const shell = `group relative flex flex-col bg-card rounded-xl3 shadow-card overflow-hidden ${focused ? 'ring-2 ring-accent' : ''}`;

  if (selectable) {
    return (
      <div
        data-ad-id={ad.id}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onToggleSelect?.(ad)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggleSelect?.(ad)}
        className={`${shell} cursor-pointer ${selected ? 'ring-2 ring-accent' : ''}`}
      >
        {selectMark}
        {bar}
        <Creative ad={ad} />
      </div>
    );
  }

  return (
    <div data-ad-id={ad.id} className={shell}>
      {bar}
      {error && <p className="px-4 pb-2 text-small text-status-bad-text">{error}</p>}
      <Creative ad={ad} />
    </div>
  );
}
