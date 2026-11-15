import { label } from "@/lib/label";
export const Button = ({ text }: { text: string }) => <button>{label(text)}</button>;
