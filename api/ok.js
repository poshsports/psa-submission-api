export default function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send('Posh PSA app installed. You can close this tab.');
}
