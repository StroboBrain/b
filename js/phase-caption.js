/** Replace the label immediately for accessibility while CSS crossfades its painted copies. */
export function setPhaseCaption(element, text, duration = 420) {
  if (typeof text !== 'string' || !element) throw new TypeError('A phase caption needs an element and text.');
  if (element.textContent === text) return;
  const previous = element.textContent;
  if (!element.ownerDocument?.createElement) { element.textContent = text; return; }
  element.classList.remove('is-changing');
  element.dataset.previousText = previous;
  element.style.setProperty('--caption-duration', `${duration}ms`);
  const current = element.ownerDocument.createElement('span');
  current.className = 'caption-current';
  current.textContent = text;
  element.replaceChildren(current);
  if (previous && element.closest('.exercise-stage')?.dataset.showText !== 'false') {
    void element.offsetWidth;
    element.classList.add('is-changing');
  }
}
