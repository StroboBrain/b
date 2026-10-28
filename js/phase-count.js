import { validateTenths } from './breathing-engine.js';

/** Keep the ones digit at the orb center while its other digits extend to either side. */
export function setPhaseCount(element, value) {
  if (!element) throw new TypeError('A countdown requires an element.');
  const text = String(validateTenths(value, 0, 99, 'A countdown'));
  if (!element.ownerDocument?.createElement) {
    if (element.textContent !== text) element.textContent = text;
    return;
  }
  if (element.textContent === text && element.querySelector('.count-unit')) return;
  const [whole, fraction] = text.split('.');
  const parts = [whole.slice(0, -1), whole.slice(-1), fraction === undefined ? '' : `.${fraction}`];
  const children = ['count-leading', 'count-unit', 'count-fraction'].map((className, index) => {
    const span = element.ownerDocument.createElement('span');
    span.className = className;
    span.textContent = parts[index];
    return span;
  });
  element.replaceChildren(...children);
}
