const slides = document.querySelectorAll('.carousel-item');
const dots   = document.querySelectorAll('.td-dot');
const bar    = document.getElementById('progressBar');
let current  = 0;
let interval;
  const DURATION = 8000; // ms per slide

  function goTo(idx) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (idx + slides.length) % slides.length;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    resetProgress();
  }

  function next() { goTo(current + 1); }

  function resetProgress() {
    bar.style.transition = 'none';
    bar.style.width = '0%';
    // Force reflow
    bar.offsetHeight;
    bar.style.transition = `width ${DURATION}ms linear`;
    bar.style.width = '100%';
  }

  function startAuto() {
    clearInterval(interval);
    interval = setInterval(next, DURATION);
    resetProgress();
  }

  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      goTo(parseInt(dot.dataset.index));
      clearInterval(interval);
      interval = setInterval(next, DURATION);
    });
  });

  startAuto();
//CARPUSEL PLANES
(function() {
  const track  = document.getElementById('planesTrack');
  const outer  = track ? track.closest('.planes-track-outer') : null;
  const dots   = document.querySelectorAll('#planesDots .planes-dot');
  if (!track || !outer) return;

  let current  = 0;
  let startX   = 0;
  let startY   = 0;
  let diffX    = 0;
  let isDragging = false;
  let isHorizontal = null; // null = undecided, true = horizontal, false = vertical

  function getCardWidth() {
    const card = track.querySelector('.plan-card');
    return card ? card.offsetWidth + 16 : 0; // 16 = margin (8px each side)
  }

  function goTo(idx) {
    const total = dots.length;
    current = Math.max(0, Math.min(idx, total - 1));
    track.style.transition = 'transform .38s cubic-bezier(.4,0,.2,1)';
    track.style.transform  = `translateX(-${current * getCardWidth()}px)`;
    dots.forEach((d, i) => d.classList.toggle('active', i === current));
  }

  dots.forEach(dot => {
    dot.addEventListener('click', () => goTo(parseInt(dot.dataset.idx)));
  });

  // Attach touch events to outer container so full swipe area is captured
  outer.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    diffX  = 0;
    isDragging   = true;
    isHorizontal = null;
    track.style.transition = 'none'; // remove transition while dragging
  }, { passive: true });

  outer.addEventListener('touchmove', e => {
    if (!isDragging) return;
    diffX = startX - e.touches[0].clientX;
    const diffY = startY - e.touches[0].clientY;

    // Decide direction on first significant move
    if (isHorizontal === null && (Math.abs(diffX) > 4 || Math.abs(diffY) > 4)) {
      isHorizontal = Math.abs(diffX) > Math.abs(diffY);
    }

    // Only prevent vertical scroll when swiping horizontally
    if (isHorizontal) {
      e.preventDefault();
      const base = current * getCardWidth();
      track.style.transform = `translateX(${-(base + diffX)}px)`;
    }
  }, { passive: false }); // passive:false needed for preventDefault

  outer.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;

    if (isHorizontal && Math.abs(diffX) > 40) {
      goTo(diffX > 0 ? current + 1 : current - 1);
    } else {
      // Snap back to current if swipe was too short
      goTo(current);
    }
    isHorizontal = null;
  });

  // Recalculate on resize
  window.addEventListener('resize', () => goTo(current));
})();

//FAQ DESPLEGABLE
(function() {
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      // Close all
      document.querySelectorAll('.faq-item.open').forEach(el => el.classList.remove('open'));
      // Toggle clicked
      if (!isOpen) item.classList.add('open');
    });
  });
})();