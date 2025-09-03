// pages/index.tsx
import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: '/index.html', // this is now served from /public
      permanent: false,
    },
  };
};

export default function Home() {
  return null;
}
