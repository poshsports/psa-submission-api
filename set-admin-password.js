import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const USER_ID = '531e4364-9454-4472-a182-48053dae9ef1'; // from Supabase Auth UI
const NEW_PASSWORD = 'Bigalsucks1785!';

const { data: before } = await sb.auth.admin.getUserById(USER_ID);

console.log('Target project:', process.env.SUPABASE_URL);
console.log('User before:', {
  id: before?.user?.id,
  email: before?.user?.email,
  providers: before?.user?.app_metadata?.providers,
});

await sb.auth.admin.updateUserById(USER_ID, {
  password: NEW_PASSWORD,
});

const { data: after } = await sb.auth.admin.getUserById(USER_ID);

console.log('User after:', {
  id: after?.user?.id,
  email: after?.user?.email,
  providers: after?.user?.app_metadata?.providers,
});

console.log('Password updated.');
