// Daily Dig: renders today's feed (built daily by scripts/build-feed.mjs) as
// full-screen posts you swipe through, with a hard stop at the end.

const feedEl = document.getElementById('feed');
const progressText = document.querySelector('.progress-text');
const progressFill = document.querySelector('.progress-bar > span');

// ------------------------------------------------------------------ storage
// Browser storage can be unavailable (private mode), so every access is guarded.

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`dd:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`dd:${key}`, JSON.stringify(value));
    } catch {}
  },
};

// ------------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : String(c));
  return el;
}

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

const ICONS = {
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4.2-6 4.2z"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  trowel: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M32 6 50 30 32 44 14 30Z"/><path d="M32 44v8"/><rect x="27" y="52" width="10" height="8" rx="3"/></svg>',
};

const minutes = (seconds) => Math.max(1, Math.round(seconds / 60));

function formatDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function credit(image) {
  if (!image) return null;
  const who = image.artist && image.artist !== 'Unknown' ? image.artist : 'Unknown author';
  return h('p', {}, h('a', { href: image.page, target: '_blank', rel: 'noopener' }, who), image.license ? ` · ${image.license}` : '');
}

// -------------------------------------------------------------------- saved

let saved = store.get('saved', []);
const isSaved = (id) => saved.some((p) => p.id === id);

function toggleSaved(post, button) {
  if (isSaved(post.id)) saved = saved.filter((p) => p.id !== post.id);
  else saved = [{ ...post, savedAt: Date.now() }, ...saved];
  store.set('saved', saved);
  const on = isSaved(post.id);
  button.classList.toggle('is-saved', on);
  button.setAttribute('aria-pressed', String(on));
  button.lastChild.textContent = on ? 'Saved' : 'Save';
}

// -------------------------------------------------------------------- posts

function coverCard(post) {
  const cards = post.cards.length;
  return h('section', { class: 'card cover' },
    h('img', { src: post.cover.src, alt: '', width: post.cover.width, height: post.cover.height, loading: 'lazy', decoding: 'async' }),
    h('div', { class: 'cover-text' },
      h('span', { class: 'chip' }, post.topicLabel),
      h('h2', {}, post.title),
      post.description ? h('p', { class: 'desc' }, post.description) : null,
      h('div', { class: 'meta' },
        h('span', {}, `${minutes(post.readSeconds)} min read`),
        h('span', {}, `Swipe · ${cards} ${cards === 1 ? 'card' : 'cards'} →`),
      ),
    ),
  );
}

function storyCard(card, i, total) {
  const img = card.image;
  return h('section', { class: `card story${img ? '' : ' text-only'}${i === 0 ? ' is-first' : ''}` },
    img
      ? h('div', { class: 'story-image' },
          h('img', { class: 'backdrop', src: img.src, alt: '', loading: 'lazy', 'aria-hidden': 'true' }),
          h('img', { class: 'main', src: img.src, alt: img.caption || '', loading: 'lazy', decoding: 'async' }),
        )
      : null,
    h('div', { class: 'story-body' },
      img?.caption ? h('p', { class: 'caption' }, img.caption) : null,
      h('p', { class: 'text' }, card.text),
      h('div', { class: 'page-num' }, `${i + 1} / ${total}`),
    ),
  );
}

function endCard(post) {
  const images = [post.cover, ...post.cards.map((c) => c.image)].filter(Boolean)
    .filter((img, i, all) => all.findIndex((o) => o.page === img.page) === i);
  return h('section', { class: 'card end' },
    h('h3', {}, post.truncated ? 'There’s more to this story.' : 'Curious for more?'),
    h('p', { class: 'hint' }, 'The full article has the detail, sources and further reading.'),
    h('a', { class: 'button', href: post.url, target: '_blank', rel: 'noopener' }, 'Read on Wikipedia', svg(ICONS.external)),
    h('div', { class: 'credits' },
      h('p', {}, 'Text from ', h('a', { href: post.url, target: '_blank', rel: 'noopener' }, 'Wikipedia'), ' · CC BY-SA 4.0'),
      h('p', {}, 'Images:'),
      images.map(credit),
    ),
    h('p', { class: 'hint' }, 'Scroll down for the next post ↓'),
  );
}

function renderPost(post, index) {
  const carousel = h('div', { class: 'carousel' },
    coverCard(post),
    post.cards.map((c, i) => storyCard(c, i, post.cards.length)),
    endCard(post),
  );
  const count = post.cards.length + 2;
  const dots = h('div', { class: 'dots', 'aria-hidden': 'true' },
    Array.from({ length: count }, (_, i) => h('span', { class: `dot${i === 0 ? ' is-active' : ''}` })),
  );

  let frame;
  carousel.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const active = Math.round(carousel.scrollLeft / carousel.clientWidth);
      dots.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('is-active', i === active));
    });
  }, { passive: true });

  const saveBtn = h('button', { class: `icon-btn${isSaved(post.id) ? ' is-saved' : ''}`, 'aria-pressed': String(isSaved(post.id)) },
    svg(ICONS.bookmark), h('span', {}, isSaved(post.id) ? 'Saved' : 'Save'));
  saveBtn.addEventListener('click', () => toggleSaved(post, saveBtn));

  return h('article', { class: 'post', 'data-id': post.id, 'data-index': index, 'aria-label': post.title },
    carousel,
    h('footer', { class: 'post-footer' },
      dots,
      h('div', { class: 'actions' },
        saveBtn,
        h('a', { class: 'icon-btn', href: post.url, target: '_blank', rel: 'noopener' }, svg(ICONS.external), 'Wikipedia'),
      ),
    ),
  );
}

function screen(title, text, small) {
  return h('section', { class: 'screen' },
    h('div', { class: 'mark' }, svg(ICONS.trowel)),
    h('h2', {}, title),
    h('p', {}, text),
    small ? h('p', { class: 'small' }, small) : null,
  );
}

// ----------------------------------------------------------------- progress

let feed = null;
let observer = null;

function readKey() {
  return `read:${feed.date}`;
}

function updateProgress() {
  if (!feed) return;
  const read = store.get(readKey(), []).length;
  const total = feed.posts.length;
  progressText.textContent = `${Math.min(read, total)} of ${total}`;
  progressFill.style.width = `${total ? (Math.min(read, total) / total) * 100 : 0}%`;
}

function watchPosts() {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || document.body.dataset.view !== 'today') continue;
      const { id, index } = entry.target.dataset;
      const read = new Set(store.get(readKey(), []));
      read.add(id);
      store.set(readKey(), [...read]);
      store.set('position', { date: feed.date, index: Number(index) });
      updateProgress();
    }
  }, { root: feedEl, threshold: 0.6 });
  feedEl.querySelectorAll('.post').forEach((p) => observer.observe(p));
}

// Shrinks a card's text a little when it doesn't fit, so cards rarely need scrolling.
function fitText(root = feedEl) {
  for (const body of root.querySelectorAll('.story-body')) {
    const text = body.querySelector('.text');
    text.style.fontSize = '';
    let size = parseFloat(getComputedStyle(text).fontSize);
    while (body.scrollHeight > body.clientHeight + 1 && size > 16) {
      size -= 0.5;
      text.style.fontSize = `${size}px`;
    }
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => fitText(), 150);
});

// -------------------------------------------------------------------- views

function showToday() {
  feedEl.replaceChildren();
  if (!feed) {
    feedEl.append(screen('No dig yet today', 'Today’s posts haven’t arrived. Check your connection, or try again shortly.'));
    return;
  }

  feedEl.append(...feed.posts.map(renderPost));
  const mins = minutes(feed.totalReadSeconds);
  feedEl.append(screen(
    'You’re all caught up',
    `That’s today’s ${feed.posts.length} snippets, about ${mins} minutes of reading. A fresh batch arrives tomorrow morning.`,
    `Dug up ${formatDate(feed.date)}`,
  ));

  fitText();
  watchPosts();
  updateProgress();

  const pos = store.get('position', null);
  if (pos?.date === feed.date && pos.index > 0) {
    requestAnimationFrame(() => feedEl.children[pos.index]?.scrollIntoView({ block: 'start' }));
  }
}

function showSaved() {
  observer?.disconnect();
  feedEl.replaceChildren();
  if (!saved.length) {
    feedEl.append(screen('Nothing saved yet', 'Tap Save on any post to keep it here. Saved posts stay on this phone.'));
    return;
  }
  feedEl.append(...saved.map(renderPost));
  fitText();
  feedEl.append(screen('That’s everything you’ve saved', `${saved.length} ${saved.length === 1 ? 'post' : 'posts'} kept on this phone.`));
}

function setView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  feedEl.scrollTop = 0;
  if (view === 'saved') showSaved();
  else showToday();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

// --------------------------------------------------------------------- boot

async function loadFeed() {
  try {
    const res = await fetch('feed/latest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch (err) {
    console.warn('Could not load feed', err);
    return null;
  }
}

// Asks the service worker to download today's feed and images for offline reading.
// On the very first visit it isn't in control yet, so wait until it is.
function precacheImages() {
  if (!feed) return;
  const sw = navigator.serviceWorker;
  if (!sw.controller) {
    sw.addEventListener('controllerchange', precacheImages, { once: true });
    return;
  }
  const urls = feed.posts.flatMap((p) => [p.cover.src, ...p.cards.map((c) => c.image?.src)]).filter(Boolean);
  sw.controller.postMessage({ type: 'precache-images', urls, feedUrl: new URL('feed/latest.json', location.href).href });
}

feed = await loadFeed();
setView('today');
document.fonts?.ready.then(() => fitText());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(precacheImages).catch(() => {});
}
