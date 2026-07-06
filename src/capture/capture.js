'use strict';

const ta = document.getElementById('capture-text');
ta.focus();

ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    window.quill.captureAppend(ta.value);
  } else if (e.key === 'Escape') {
    window.quill.captureClose();
  }
});
