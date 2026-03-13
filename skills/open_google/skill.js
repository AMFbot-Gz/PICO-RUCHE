export async function run(params) {
  const { exec } = await import('child_process');
  return new Promise((resolve, reject) => {
    exec('open -a Safari https://google.com', (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ success: true, message: 'Google ouvert dans Safari' });
    });
  });
}