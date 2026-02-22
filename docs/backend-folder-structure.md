# NestJS Backend - Folder Structure

This document outlines the folder structure and best practices for our NestJS backend application.

## Root Structure

```
project-root/
├── .github/                    # GitHub workflows and configurations
├── .vscode/                    # VS Code settings
├── dist/                       # Compiled output (generated)
├── docs/                       # Documentation files
├── node_modules/               # Dependencies (generated)
├── prisma/                     # Database schema and migrations
├── scripts/                    # Utility scripts
├── src/                        # Application source code
├── test/                       # E2E tests
├── views/                      # Email/PDF templates
├── .env.development            # Development environment variables
├── .env.staging                # Staging environment variables
├── .env.production             # Production environment variables
├── Dockerfile                  # Docker build configuration
├── package.json
└── tsconfig.json
```

## Source Code Structure (`src/`)

```
src/
├── main.ts                     # Application entry point
├── app.module.ts               # Root module
├── app.controller.ts           # Root controller
├── app.service.ts              # Root service
│
├── common/                     # Shared utilities
│   ├── constants/              # Application constants
│   ├── dto/                    # Shared DTOs (PaginationDto, etc.)
│   ├── entities/               # Shared entity classes
│   └── test/                   # Test utilities
│
├── core/                       # Core infrastructure
│   ├── decorators/             # Custom decorators
│   ├── filters/                # Exception filters
│   ├── interceptors/           # Request/response interceptors
│   ├── transports/             # Custom transports (logging, etc.)
│   └── types/                  # TypeScript type definitions
│
├── prisma/                     # Prisma service wrapper
│
└── [feature-module]/           # Feature modules (see below)
```

## Feature Module Structure

Each feature module follows a consistent structure:

```
src/[module-name]/
├── [module-name].module.ts         # Module definition
├── [module-name].controller.ts     # HTTP request handlers
├── [module-name].service.ts        # Business logic
├── [module-name].service.spec.ts   # Unit tests (optional)
│
├── dto/                            # Data Transfer Objects
│   ├── index.ts                    # Barrel export
│   ├── create-[entity].dto.ts     # Create operation DTO
│   ├── update-[entity].dto.ts     # Update operation DTO
│   ├── filter-[entity].dto.ts     # List/filter operation DTO
│   └── [other].dto.ts             # Additional DTOs as needed
│
├── entities/                       # Response entities
│   ├── index.ts                    # Barrel export
│   └── [entity].entity.ts         # Entity class for serialization
│
├── enums/                          # Module-specific enums (optional)
│   ├── index.ts
│   └── [enum-name].enum.ts
│
├── guards/                         # Module-specific guards (optional)
│
├── decorators/                     # Module-specific decorators (optional)
│
├── interfaces/                     # TypeScript interfaces (optional)
│
└── __mocks__/                      # Test mocks (optional)
```

## Prisma Structure (`prisma/`)

```
prisma/
├── schema.prisma               # Database schema definition
├── migrations/                 # Database migrations
│   └── [timestamp]_[name]/
│       └── migration.sql
└── seeds/                      # Database seed scripts
    └── [entity].seed.ts
```

## Naming Conventions

### Files

| Type       | Pattern                    | Example                        |
| ---------- | -------------------------- | ------------------------------ |
| Module     | `kebab-case.module.ts`     | `user-profile.module.ts`       |
| Controller | `kebab-case.controller.ts` | `user-profile.controller.ts`   |
| Service    | `kebab-case.service.ts`    | `user-profile.service.ts`      |
| DTO        | `action-entity.dto.ts`     | `create-user.dto.ts`           |
| Entity     | `entity-name.entity.ts`    | `user.entity.ts`               |
| Guard      | `guard-name.guard.ts`      | `permissions.guard.ts`         |
| Enum       | `enum-name.enum.ts`        | `user-status.enum.ts`          |
| Test       | `*.spec.ts`                | `user-profile.service.spec.ts` |

### Classes

| Type       | Pattern                | Example                 |
| ---------- | ---------------------- | ----------------------- |
| Module     | `PascalCaseModule`     | `UserProfileModule`     |
| Controller | `PascalCaseController` | `UserProfileController` |
| Service    | `PascalCaseService`    | `UserProfileService`    |
| DTO        | `ActionEntityDto`      | `CreateUserDto`         |
| Entity     | `EntityNameEntity`     | `UserEntity`            |

### Database

- **Tables**: `PascalCase` (Prisma model names)
- **Columns**: `camelCase`
- **Foreign Keys**: `entityID` (e.g., `companyID`, `userID`)

## Best Practices

### 1. Module Organization

- Each domain/feature has its own module
- Modules are self-contained with their own DTOs, entities, and services
- Use barrel exports (`index.ts`) for clean imports

### 2. DTO Patterns

```typescript
// CreateDto - required fields for creation
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}

// UpdateDto - all fields optional via PartialType
export class UpdateUserDto extends PartialType(CreateUserDto) {}

// FilterDto - extends PaginationDto for list endpoints
export class FilterUserDto extends PaginationDto {
  @IsOptional()
  search?: string;
}
```

### 3. Entity Patterns

```typescript
export class UserEntity {
  @Exclude()
  id: number; // Hide internal ID

  @ApiProperty()
  uid: string; // Expose public UID

  @Exclude()
  deletedAt: Date; // Hide soft delete timestamp

  constructor(partial: Partial<UserEntity>) {
    Object.assign(this, partial);
  }
}
```

### 4. Service Patterns

- Validate ownership for multi-tenant operations
- Use soft deletes (`deletedAt`) instead of hard deletes
- Return entity instances, not raw Prisma objects

### 5. Controller Patterns

- Use guards for authentication and authorization
- Apply `@ApiTags()` for Swagger grouping
- Use `ClassSerializerInterceptor` for response transformation

### 6. Seed File Patterns

- Check for existing records before creating
- Support idempotent re-runs (update if exists, create if not)
- Log progress with summary at the end
