// pages/admin/index.tsx
export async function getServerSideProps() {
  return {
    redirect: { destination: '/admin/groups', permanent: false },
  };
}
export default function AdminIndex() {
  return null;
}
