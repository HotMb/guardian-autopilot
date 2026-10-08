import Image from 'next/image';
import styles from './page.module.css';

export default function Home() {
  return (
    <main className={styles.hero}>
      <Image src="/images/card.png?width=1200" alt="Card" width={1200} height={800} />
      <img src="/hero.webp" alt="Hero" />
      <img src={`/${process.env.NEXT_PUBLIC_THEME}/hero.webp`} alt="Dynamic" />
      <img src="https://cdn.example.com/remote.webp" alt="Remote" />
    </main>
  );
}
