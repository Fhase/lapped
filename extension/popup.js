const message = document.querySelector('#message'), button = document.querySelector('#scan'), input = document.querySelector('#app-url');
chrome.storage.sync.get({ appUrl: 'http://localhost:3000' }, ({ appUrl }) => input.value = appUrl);
input.addEventListener('change', () => chrome.storage.sync.set({ appUrl: input.value.replace(/\/$/, '') }));
button.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const match = tab.url?.match(/strava\.com\/activities\/(\d+)/);
  if (!match) return message.textContent = 'Open an individual Strava activity first.';
  button.disabled = true; message.textContent = 'Checking completed segment efforts…';
  try {
    const appUrl = input.value.replace(/\/$/, '');
    const response = await fetch(`${appUrl}/api/activities/${match[1]}/scan`, { method: 'POST', credentials: 'include' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    message.textContent = data.lapCount ? `${data.lapCount} lap${data.lapCount === 1 ? '' : 's'} added to this ride.` : 'No completed High Park laps — description left untouched.';
  } catch (error) { message.textContent = error.message || 'Could not reach the app. Connect Strava first.'; }
  button.disabled = false;
};
