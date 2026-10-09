import { config } from "@repo/eslint-config/react-internal";

export default [...config, { ignores: ["dist/**", "src/routeTree.gen.ts", "src/components/ui/**"] }];
