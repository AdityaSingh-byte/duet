import type { TextStyle } from 'react-native';

export const colors = {
  text: '#1d1d1f',
  muted: '#5f6368',
  line: '#e3e3e3',
  page: '#ffffff',
  field: '#f4f4f4',
  primary: '#1d1d1f',
  onPrimary: '#ffffff',
  link: '#1a5fb4',
  stage: '#111111',
  onStage: '#ffffff',
  onStageMuted: '#a0a4a8',
  overlay: 'rgba(0,0,0,0.6)',
};

export const type = {
  title: { fontSize: 20, fontWeight: '600', color: colors.text } satisfies TextStyle,
  body: { fontSize: 15, color: colors.text } satisfies TextStyle,
  label: { fontSize: 13, fontWeight: '600', color: colors.muted } satisfies TextStyle,
  muted: { fontSize: 13, color: colors.muted } satisfies TextStyle,
  small: { fontSize: 13, fontWeight: '500', color: colors.text } satisfies TextStyle,
  link: { fontSize: 15, color: colors.link } satisfies TextStyle,
};
