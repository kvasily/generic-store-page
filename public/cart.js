// Optional enhancement: ordinary POST forms still work with JavaScript disabled.
for (const form of document.querySelectorAll('[data-add-to-cart]')) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const feedback = form.parentElement.querySelector('[data-cart-feedback]');
    const buttons = [...document.querySelectorAll('[data-add-to-cart] button')];
    if (buttons.some(button => button.disabled)) return;
    for (const button of buttons) button.disabled = true;
    feedback.textContent = 'Adding to your cart…';
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        body: new URLSearchParams(new FormData(form))
      });
      const result = await response.json();
      if (!response.ok) {
        feedback.textContent = result.error || 'Could not add this product. Please try again.';
        return;
      }
      for (const count of document.querySelectorAll('[data-cart-count]')) {
        count.textContent = String(result.count);
      }
      feedback.textContent = `${result.product} added. ${result.quantity} in your cart.`;
    } catch {
      // The server may have saved the addition even if its response was lost.
      feedback.textContent = 'Could not confirm the update. Check your cart before trying again.';
    } finally {
      for (const button of buttons) button.disabled = false;
    }
  });
}
