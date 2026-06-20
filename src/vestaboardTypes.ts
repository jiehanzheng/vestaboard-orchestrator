export type VestaboardBoard = "note" | "flagship";
export type VestaboardBoardPreference = VestaboardBoard | "auto";
export type VestaboardBoardProvider = () => Promise<VestaboardBoard>;
